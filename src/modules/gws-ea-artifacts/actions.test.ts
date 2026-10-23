import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/private/tmp/gws-ea-artifact-actions-${process.pid}` }));
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
import { ARTIFACTS_POLICY_FILE_ENV, type ArtifactsPolicyFile } from './policy.js';

let author: Session;
let main: Session;
let peer: Session;
let serial = 0;
const policy: ArtifactsPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: 'views.example.com',
  pathPrefix: '/aya',
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
  vi.stubEnv(ARTIFACTS_POLICY_FILE_ENV, path.join(ROOT, 'policy.json'));
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
  expect(first.url).toBe(`https://views.example.com/aya/${String(first.artifact_id)}`);
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
  expect(checkout.file).toBe(`inbox/checkout/${String(artifactId)}-r1.html`);
  expect(fs.readFileSync(path.join(sessionDir('author', another.id), String(checkout.file)), 'utf8')).toContain(
    '<h1>Trip</h1>',
  );
  expect(fs.existsSync(path.join(sessionDir('author', author.id), String(checkout.file)))).toBe(false);
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
