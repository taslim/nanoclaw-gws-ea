import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `gws-ea-artifact-actions-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
import '../index.js';
import { getGroupCapabilities } from '../../capabilities.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { runGuarded } from '../../delivery-guard.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSystemSession, sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { ARTIFACT_ACTIONS } from './actions.js';
import { WEB_POLICY_FILE_ENV, type WebPolicyFile } from '../gws-ea-web/policy.js';

let author: Session;
let main: Session;
let peer: Session;
let serial = 0;
const policy: WebPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: 'aya.example.com',
  listenPort: 9123,
  accessIssuer: 'https://team.cloudflareaccess.com',
  accessAud: 'assistant-aud',
  cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: '/private/tmp/operator.json' },
};
function writePolicy(enabled = true): void {
  fs.writeFileSync(path.join(ROOT, 'policy.json'), JSON.stringify({ ...policy, enabled }), { mode: 0o600 });
}
function stage(
  session: Session,
  requestId: string,
  bytes: string | Buffer = '<!doctype html><html><body><h1>Trip</h1></body></html>',
): string {
  const directory = path.join(sessionDir(session.agent_group_id, session.id), 'outbox', requestId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'view.html');
  fs.writeFileSync(file, bytes);
  return file;
}
async function request(
  session: Session,
  name: string,
  fields: Record<string, unknown>,
  id = `req-${++serial}`,
): Promise<ResponseFrame> {
  const action = ARTIFACT_ACTIONS.find(([key]) => key === name);
  if (!action) throw new Error(`Unknown artifact action ${name}`);
  await runGuarded(name, action[2], action[1], { action: name, requestId: id, ...fields }, session, null);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const row = db.prepare('SELECT content,trigger FROM messages_in WHERE id=?').get(`action-resp-${id}`) as {
      content: string;
      trigger: number;
    };
    expect(row.trigger).toBe(0);
    return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
  } finally {
    db.close();
  }
}
function accepted(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(frame.error.message);
  return frame.data as Record<string, unknown>;
}
function refusal(frame: ResponseFrame): string {
  if (frame.ok) throw new Error('Unexpectedly accepted artifact request');
  return frame.error.message;
}
function loseAnswer(session: Session, requestId: string): void {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    db.prepare('DELETE FROM messages_in WHERE id=?').run(`action-resp-${requestId}`);
  } finally {
    db.close();
  }
}
async function made(session = author, id = `save-${++serial}`): Promise<Record<string, unknown>> {
  stage(session, id);
  return accepted(await request(session, 'artifact_save', { create_key: id, title: 'Trip', file: 'view.html' }, id));
}
beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  vi.stubEnv(WEB_POLICY_FILE_ENV, path.join(ROOT, 'policy.json'));
  writePolicy();
  await runMigrations(await initTestDb());
  for (const id of ['canonical', 'author', 'peer', 'sealed', 'sealed-email', 'sealed-chat']) {
    await createAgentGroup({
      id,
      name: id === 'canonical' ? 'Assistant' : id,
      folder: id,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await ensureContainerConfig(id);
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Aya',principal_first_name='Morgan',principal_timezone='America/Los_Angeles',main_agent_group_id='canonical',browser_agent_group_id='sealed',external_email_agent_group_id='sealed-email',external_chat_agent_group_id='sealed-chat' WHERE singleton=1",
  );
  await updateContainerConfigJson('author', 'capabilities', ['artifacts', 'files-read', 'files-write']);
  await updateContainerConfigJson('sealed', 'capabilities', ['artifacts']);
  await updateContainerConfigJson('sealed-email', 'capabilities', ['artifacts']);
  await updateContainerConfigJson('sealed-chat', 'capabilities', ['artifacts']);
  author = (await resolveSystemSession('author', 'system:artifacts')).session;
  main = (await resolveSystemSession('canonical', 'system:artifacts')).session;
  peer = (await resolveSystemSession('peer', 'system:artifacts')).session;
});
afterEach(async () => {
  await closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('saves through the guarded mailbox path, recovers response loss after staging cleanup, and does not duplicate revisions', async () => {
  const id = 'replay';
  const fields = { create_key: 'key', title: 'Trip', file: 'view.html' };
  stage(author, id);
  const first = accepted(await request(author, 'artifact_save', fields, id));
  expect(first.url).toBe(`https://aya.example.com/artifacts/${String(first.artifact_id)}`);
  expect(fs.existsSync(path.dirname(path.join(sessionDir('author', author.id), 'outbox', id, 'view.html')))).toBe(
    false,
  );
  loseAnswer(author, id);
  expect(accepted(await request(author, 'artifact_save', fields, id))).toEqual(first);
  expect(await getDb().all('SELECT revision FROM gws_ea_artifact_revisions')).toEqual([{ revision: 1 }]);
  loseAnswer(author, id);
  stage(author, id, '<p>Changed content</p>');
  expect(refusal(await request(author, 'artifact_save', fields, id))).toContain('different work');
  expect(await getDb().all('SELECT revision FROM gws_ea_artifact_revisions')).toEqual([{ revision: 1 }]);
});
it('uses stored main identity and live capability selection; all, sealed identities, revocation and closed sessions never inherit author tools', async () => {
  expect((await getGroupCapabilities('canonical')).has('artifacts')).toBe(true);
  expect((await getGroupCapabilities('author')).has('artifacts')).toBe(true);
  expect((await getGroupCapabilities('peer')).has('artifacts')).toBe(false);
  expect((await getGroupCapabilities('sealed')).has('artifacts')).toBe(false);
  expect((await getGroupCapabilities('sealed-email')).has('artifacts')).toBe(false);
  expect((await getGroupCapabilities('sealed-chat')).has('artifacts')).toBe(false);
  expect(refusal(await request(peer, 'artifact_list', {}))).toContain('current capability');
  await updateContainerConfigJson('author', 'capabilities', []);
  expect(refusal(await request(author, 'artifact_list', {}))).toContain('current capability');
  await updateContainerConfigJson('author', 'capabilities', ['artifacts']);
  await getDb().run("UPDATE sessions SET status='closed' WHERE id=?", author.id);
  expect(refusal(await request(author, 'artifact_list', {}))).toContain('current capability');
  writePolicy(false);
  expect((await getGroupCapabilities('canonical')).has('artifacts')).toBe(false);
  expect(refusal(await request(main, 'artifact_list', {}))).toContain('current capability');
});
it('gives own metadata and exact requested source only to the calling session inbox', async () => {
  const saved = await made();
  const artifactId = saved.artifact_id;
  const metadata = accepted(await request(author, 'artifact_read', { artifact_id: artifactId }));
  expect(metadata).not.toHaveProperty('html');
  expect(metadata).not.toHaveProperty('file');
  const another = (await resolveSystemSession('author', 'system:second-author-session')).session;
  const checkout = accepted(
    await request(another, 'artifact_read', { artifact_id: artifactId, checkout: true }, 'checkout'),
  );
  expect(checkout.file).toBe(`/workspace/inbox/checkout/${String(artifactId)}-r1.html`);
  const inboxPath = String(checkout.file).slice('/workspace/'.length);
  expect(fs.readFileSync(path.join(sessionDir('author', another.id), inboxPath), 'utf8')).toContain('<h1>Trip</h1>');
  expect(fs.existsSync(path.join(sessionDir('author', author.id), inboxPath))).toBe(false);
  await updateContainerConfigJson('peer', 'capabilities', ['artifacts']);
  expect(refusal(await request(peer, 'artifact_read', { artifact_id: artifactId, checkout: true }))).toContain(
    'unavailable to you',
  );
  expect(accepted(await request(main, 'artifact_read', { artifact_id: artifactId })).author_group_id).toBe('author');
  expect(
    refusal(await request(peer, 'artifact_delete', { artifact_id: artifactId, expected_generation: 1 })),
  ).toContain('own artifacts');
  expect(
    accepted(await request(main, 'artifact_delete', { artifact_id: artifactId, expected_generation: 1 })),
  ).toMatchObject({ deleted: true, generation: 2 });
});
it.each(['missing', 'symlink', 'fifo', 'oversized', 'utf8'] as const)(
  'refuses %s staged source without storing content',
  async (kind) => {
    const id = `unsafe-${kind}`;
    const file = stage(author, id);
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'symlink') {
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(ROOT, 'policy.json'), file);
    }
    if (kind === 'fifo') {
      fs.unlinkSync(file);
      execFileSync('mkfifo', [file]);
    }
    if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    if (kind === 'utf8') fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    expect(
      refusal(await request(author, 'artifact_save', { create_key: id, title: 'Trip', file: 'view.html' }, id)),
    ).toMatch(/missing|safe regular file|UTF-8/u);
    expect(await getDb().all('SELECT artifact_id FROM gws_ea_artifacts')).toEqual([]);
  },
);
it('rejects closed input-union mixing and file path traversal before reading source', async () => {
  expect(
    refusal(
      await request(author, 'artifact_save', {
        create_key: 'key',
        artifact_id: 'id',
        title: 'Trip',
        file: 'view.html',
      }),
    ),
  ).toContain('Choose create_key');
  expect(
    refusal(await request(author, 'artifact_save', { create_key: 'key', title: 'Trip', file: '../policy.json' })),
  ).toContain('single staged');
});

it('revokes a retired job author immediately while retaining its assistant-owned artifacts for main', async () => {
  const saved = await made();
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'job-chat',
    channel_type: 'whatsapp',
    platform_id: 'job-chat',
    name: 'Trip',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('author','job-chat','retired',?,?)",
    now,
    now,
  );
  expect((await getGroupCapabilities('author')).has('artifacts')).toBe(false);
  expect(refusal(await request(author, 'artifact_list', {}))).toContain('current capability');
  expect(accepted(await request(main, 'artifact_read', { artifact_id: saved.artifact_id })).title).toBe('Trip');
});
it('returns old revision metadata without exposing a later private title or loading its source', async () => {
  const saved = await made();
  const id = 'edit-title';
  stage(author, id, '<p>New private source</p>');
  accepted(
    await request(
      author,
      'artifact_save',
      { artifact_id: saved.artifact_id, expected_revision: 1, title: 'New private title', file: 'view.html' },
      id,
    ),
  );
  const queries = vi.spyOn(getDb(), 'get');
  const old = accepted(await request(author, 'artifact_read', { artifact_id: saved.artifact_id, revision: 1 }));
  expect(old.title).toBe('Trip');
  expect(old).not.toHaveProperty('html');
  expect(queries.mock.calls.some(([sql]) => /SELECT[^]*\bhtml\b/u.test(sql))).toBe(false);
});

it('refuses unsupported artifact documents at save, before any content is persisted', async () => {
  const id = 'remote-source';
  stage(author, id, '<html><body><img src="https://example.com/tracker.png"></body></html>');
  expect(
    refusal(await request(author, 'artifact_save', { create_key: id, title: 'Unsafe', file: 'view.html' }, id)),
  ).toContain('remote resource');
  expect(await getDb().all('SELECT artifact_id FROM gws_ea_artifacts')).toEqual([]);
});

it('refuses stale artifact tools immediately after capability disable', async () => {
  expect(accepted(await request(author, 'artifact_list', {})).artifacts).toEqual([]);
  writePolicy(false);
  expect(refusal(await request(author, 'artifact_list', {}))).toContain('current capability');
});

it('gives main current share generations and pinned metadata without disclosing source or exposing sharing controls to the author', async () => {
  const saved = await made();
  const shareId = '00000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  await getDb().run(
    "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,'named',1,?,3,'active','scope',?,?)",
    shareId,
    saved.artifact_id as string,
    saved.source_hash as string,
    now,
    now,
  );
  await getDb().run(
    'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
    shareId,
    'juno@example.com',
  );
  const read = accepted(await request(main, 'artifact_read', { artifact_id: saved.artifact_id }));
  expect(read.shares).toEqual([
    expect.objectContaining({
      share_id: shareId,
      generation: 3,
      state: 'active',
      title: 'Trip',
      recipients: ['juno@example.com'],
    }),
  ]);
  expect(JSON.stringify(read)).not.toContain('<h1>');
  const listed = accepted(await request(main, 'artifact_list', {}));
  expect(listed.artifacts).toEqual([
    expect.objectContaining({ share_summary: { named: { active: 1, pending: 0, revoked: 0 }, public: null } }),
  ]);
  expect(JSON.stringify(listed)).not.toContain('juno@example.com');
  expect(accepted(await request(author, 'artifact_read', { artifact_id: saved.artifact_id }))).not.toHaveProperty(
    'shares',
  );
});

it('pages sharing metadata without limiting stored shares and keeps artifact lists small', async () => {
  const saved = await made();
  const now = new Date().toISOString();
  for (let index = 0; index < 45; index++) {
    const id = `named-${String(index).padStart(3, '0')}`;
    await getDb().run(
      "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,scope_hash,created_at,updated_at) VALUES(?,?,'named',1,?,7,'active','scope',?,?)",
      id,
      saved.artifact_id as string,
      saved.source_hash as string,
      now,
      now,
    );
    await getDb().run(
      'INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)',
      id,
      `guest-${index}@example.com`,
    );
  }
  const seen: string[] = [];
  let after: unknown;
  do {
    const page = accepted(
      await request(main, 'artifact_read', {
        artifact_id: saved.artifact_id,
        ...(after ? { shares_after: after } : {}),
      }),
    );
    const shares = page.shares as Array<{ share_id: string; generation: number; recipients: string[] }>;
    expect(shares.length).toBeLessThanOrEqual(1);
    expect(shares.every((share) => share.generation === 7 && share.recipients.length === 1)).toBe(true);
    seen.push(...shares.map((share) => share.share_id));
    after = page.shares_next_cursor;
  } while (after);
  expect(seen).toEqual(Array.from({ length: 45 }, (_, index) => `named-${String(index).padStart(3, '0')}`));
  const listed = accepted(await request(main, 'artifact_list', {}));
  expect(listed.artifacts).toEqual([
    expect.objectContaining({ share_summary: { named: { active: 45, pending: 0, revoked: 0 }, public: null } }),
  ]);
  expect(JSON.stringify(listed)).not.toContain('guest-');
  expect(JSON.stringify(listed)).not.toContain('named-044');
});

it('keeps save, revise, checkout, list and delete available with enabled web policy while no origin runs', async () => {
  const before = await getDb().all('SELECT id,container_status FROM sessions ORDER BY id');
  const saved = await made();
  const revisionId = 'outage-revise';
  stage(author, revisionId, '<p>Revised during the origin outage</p>');
  const revised = accepted(
    await request(
      author,
      'artifact_save',
      {
        artifact_id: saved.artifact_id,
        expected_revision: 1,
        title: 'Outage revision',
        file: 'view.html',
      },
      revisionId,
    ),
  );
  expect(revised.revision).toBe(2);
  const checkout = accepted(
    await request(author, 'artifact_read', { artifact_id: saved.artifact_id, checkout: true }, 'outage-checkout'),
  );
  expect(
    fs.readFileSync(
      path.join(sessionDir('author', author.id), String(checkout.file).slice('/workspace/'.length)),
      'utf8',
    ),
  ).toBe('<p>Revised during the origin outage</p>');
  expect(accepted(await request(author, 'artifact_list', {})).artifacts).toEqual([
    expect.objectContaining({ artifact_id: saved.artifact_id, head_revision: 2 }),
  ]);
  expect(
    accepted(
      await request(author, 'artifact_delete', {
        artifact_id: saved.artifact_id,
        expected_generation: revised.generation,
      }),
    ),
  ).toMatchObject({ deleted: true });
  expect((await getGroupCapabilities('author')).has('artifacts')).toBe(true);
  expect(await getDb().all('SELECT id,container_status FROM sessions ORDER BY id')).toEqual(before);
});
