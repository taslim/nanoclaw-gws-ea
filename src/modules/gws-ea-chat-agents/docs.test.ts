import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { ROOT } = vi.hoisted(() => ({ ROOT: `/tmp/gws-ea-job-docs-${process.pid}` }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: ROOT,
}));
vi.mock('../../log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../gws-ea-google/index.js', () => ({ hostGoogleAccessToken: vi.fn(async () => 'host-only-token') }));
vi.mock('../gws-ea-workspace/probe.js', async (original) => ({
  ...(await original<typeof import('../gws-ea-workspace/probe.js')>()),
  probeLink: async () => 'sign-in',
}));

import '../permissions/index.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-people/index.js';
import '../gws-ea-privacy/index.js';
import '../gws-ea-matters/index.js';
import '../gws-ea-chats/index.js';
import '../gws-ea-artifacts/index.js';
import './index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { runGuarded } from '../../delivery-guard.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { refreshChatRoster, setChatMemberEmail } from '../gws-ea-chats/roster.js';
import { addPrivateValue } from '../gws-ea-privacy/db.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';
import { prepareArtifactSource, saveArtifact } from '../gws-ea-artifacts/db.js';
import { generateDriveFileId } from '../gws-ea-workspace/drive-api.js';
import { JOB_DOCUMENT_ACTIONS } from './docs.js';
import { createWhatsAppGroupEvents } from '../gws-ea-whatsapp/events.js';
import { WhatsAppIndex } from '../gws-ea-whatsapp/index-store.js';
import { FakeSocket } from '../gws-ea-whatsapp/testing/fake-socket.js';
let drive: FakeDrive;
let job: Session;
let external: Session;
let sequence = 0;
let nativeGroups: ReturnType<typeof createWhatsAppGroupEvents> | undefined;
let members = [
  { key: 'whatsapp:22', isPrincipal: false },
  { key: 'whatsapp:11', isPrincipal: true },
];
const documents = new Map<string, { title: string; text: string; revision: number }>();
const markers = new Map<string, string>();
const bodyReads: string[] = [];
const folderCreates: { readonly id: string; readonly name?: string }[] = [];
const folderReservations: (string | undefined)[] = [];
// The shared fake chooses its own IDs; this HTTP boundary preserves Drive's reserved native IDs.
const folderIds = new Map<string, string>();
let generatedFolderIds = 0;
let hideFolders = false;
let loseFolderResponse = false;
let loseCreateResponse = false;
let loseEditResponse = false;
let omitRevision = false;
registerChannelAdapter('whatsapp', {
  factory: () => ({
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
    fetchGroupMembers: async (platformId: string) =>
      nativeGroups ? nativeGroups.fetchGroupMembers(platformId) : { platformId, name: 'Trip', members },
  }),
});

async function request(
  session: Session,
  name: string,
  fields: Record<string, unknown> = {},
  id = `docs-test-${++sequence}`,
): Promise<ResponseFrame> {
  const action = JOB_DOCUMENT_ACTIONS.find(([key]) => key === name);
  if (!action) throw new Error(`Missing action ${name}`);
  await runGuarded(name, action[2], action[1], { action: name, requestId: id, ...fields }, session, null);
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(`action-resp-${id}`) as {
      content: string;
    };
    return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
  } finally {
    db.close();
  }
}
function loseAnswer(session: Session, id: string): void {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id));
  try {
    db.prepare('DELETE FROM messages_in WHERE id=?').run(`action-resp-${id}`);
  } finally {
    db.close();
  }
}
function accepted(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(frame.error.message);
  return frame.data as Record<string, unknown>;
}
function refused(frame: ResponseFrame): string {
  if (frame.ok) throw new Error('Unexpectedly accepted');
  return frame.error.message;
}
async function made(): Promise<string> {
  return String(accepted(await request(job, 'doc_create', { title: 'Trip plan', text: 'Friday at the lake.' })).file);
}
async function observedRevision(file: string): Promise<string> {
  const revision = accepted(await request(job, 'doc_read', { file })).revision;
  if (typeof revision !== 'string' || revision.length === 0) throw new Error('doc_read did not return a revision');
  return revision;
}
function enableArtifacts(): void {
  const policy = `${ROOT}/artifact-policy.json`;
  fs.writeFileSync(
    policy,
    JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      hostname: 'views.example.com',
      pathPrefix: '/aya',
      listenPort: 9123,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAud: 'aud',
      cloudflare: { accountId: 'a', applicationId: 'b', operatorConfigFile: '/private/tmp/cf.json' },
    }),
    { mode: 0o600 },
  );
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', policy);
}
async function privateArtifactLink(): Promise<string> {
  enableArtifacts();
  await addPrincipalAddress('principal@example.com');
  const saved = await saveArtifact(
    { agentGroupId: job.agent_group_id, sessionId: job.id, isMain: false },
    { requestId: 'fixture-artifact', action: 'save', fingerprint: 'fixture-artifact' },
    { create_key: 'report', title: 'Report' },
    prepareArtifactSource(Buffer.from('<p>Report</p>')),
  );
  return `https://views.example.com/aya/${saved.artifact_id}`;
}
async function outsideFile(): Promise<string> {
  const file = await drive.createFile({ name: 'Outside document', mimeType: 'application/vnd.google-apps.document' });
  documents.set(file.id, { title: 'Outside document', text: 'Everyone may read this.', revision: 1 });
  return file.id;
}
beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  documents.clear();
  markers.clear();
  bodyReads.length = 0;
  folderCreates.length = 0;
  folderReservations.length = 0;
  folderIds.clear();
  generatedFolderIds = 0;
  hideFolders = false;
  loseFolderResponse = false;
  loseCreateResponse = false;
  loseEditResponse = false;
  omitRevision = false;
  nativeGroups = undefined;
  members = [
    { key: 'whatsapp:22', isPrincipal: false },
    { key: 'whatsapp:11', isPrincipal: true },
  ];
  drive = new FakeDrive('assistant@example.com');
  drive.addAccount('mira@example.com');
  drive.addAccount('new@example.com');
  await runMigrations(await initTestDb());
  const at = new Date().toISOString();
  for (const id of ['job', 'external'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: at });
  await getDb().run(
    "UPDATE gws_ea_profile SET external_chat_agent_group_id='external',assistant_workspace_email='assistant@example.com' WHERE singleton=1",
  );
  for (const [chat, agent, state] of [
    ['trip', 'job', 'job'],
    ['other', 'external', 'connected'],
  ]) {
    await createMessagingGroup({
      id: chat,
      channel_type: 'whatsapp',
      platform_id: `${chat}@g.us`,
      name: 'Trip',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: at,
    });
    await getDb().run(
      'INSERT INTO gws_ea_chats(messaging_group_id,state,serving_agent_group_id,principal_present,created_at,updated_at) VALUES(?,?,?,1,?,?)',
      chat,
      state,
      agent,
      at,
      at,
    );
    await refreshChatRoster(chat, members);
  }
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('job','trip','active',?,?)",
    at,
    at,
  );
  await setChatMemberEmail('trip', 'whatsapp:22', 'mira@example.com', 'main');
  job = (await resolveSession('job', 'trip', null, 'shared')).session;
  external = (await resolveSession('external', 'other', null, 'shared')).session;
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-only-token');
      const url = new URL(String(input));
      const rawBody =
        init?.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init?.body ?? '');
      const boundary = new Headers(init?.headers).get('content-type')?.split('boundary=')[1];
      const parts = boundary ? rawBody.split(`--${boundary}`) : [];
      const body: unknown = boundary
        ? JSON.parse(parts[1].split('\r\n\r\n')[1].trim())
        : rawBody
          ? JSON.parse(rawBody)
          : undefined;
      const nativeFileId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
      const fileId = folderIds.get(nativeFileId) ?? nativeFileId;
      if (url.pathname === '/drive/v3/files/generateIds')
        return Response.json({ ids: [`reserved-folder-${++generatedFolderIds}`] });
      if (url.hostname === 'docs.googleapis.com') {
        const id = decodeURIComponent(url.pathname.split('/')[3]?.replace(':batchUpdate', '') ?? '');
        const doc = documents.get(id);
        if (!doc) return Response.json({ error: { message: 'Missing document' } }, { status: 404 });
        if (init?.method !== 'POST') {
          bodyReads.push(id);
          expect(url.searchParams.get('includeTabsContent')).toBe('true');
          return Response.json({
            documentId: id,
            title: doc.title,
            ...(omitRevision ? {} : { revisionId: `r${doc.revision}` }),
            tabs: [
              {
                documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: doc.text } }] } }] } },
              },
            ],
          });
        }
        const update = body as {
          writeControl?: { requiredRevisionId: string };
          requests: {
            insertText?: { text: string };
            replaceAllText?: { containsText: { text: string; matchCase: boolean }; replaceText: string };
          }[];
        };
        if (update.writeControl && update.writeControl.requiredRevisionId !== `r${doc.revision}`)
          return Response.json({ error: { message: 'Revision changed' } }, { status: 400 });
        for (const entry of update.requests) {
          if (entry.insertText) doc.text += entry.insertText.text;
          if (entry.replaceAllText)
            doc.text = doc.text.replaceAll(entry.replaceAllText.containsText.text, entry.replaceAllText.replaceText);
        }
        doc.revision++;
        if (loseEditResponse) {
          loseEditResponse = false;
          throw new TypeError('Connection lost after applying edit');
        }
        return Response.json({});
      }
      if (
        (url.pathname === '/drive/v3/files' || url.pathname === '/upload/drive/v3/files') &&
        init?.method === 'POST'
      ) {
        const input = body as Parameters<FakeDrive['createFile']>[0] & { readonly id?: string };
        if (input.id !== undefined && folderIds.has(input.id))
          return Response.json({ error: { message: 'ID already used' } }, { status: 409 });
        if (input.mimeType === 'application/vnd.google-apps.folder') {
          const reservation = await getDb().get<{ folder_id: string }>(
            'SELECT folder_id FROM gws_ea_job_document_folders WHERE agent_group_id=?',
            'job',
          );
          folderReservations.push(reservation?.folder_id);
        }
        const made = await drive.createFile({
          ...input,
          ...(input.parents === undefined
            ? {}
            : {
                parents: input.parents.map((parent) => folderIds.get(parent) ?? parent),
              }),
        });
        const nativeId = input.id ?? made.id;
        if (made.mimeType === 'application/vnd.google-apps.folder') {
          folderIds.set(nativeId, made.id);
          folderCreates.push({ ...made, id: nativeId });
          if (loseFolderResponse) {
            loseFolderResponse = false;
            throw new TypeError('Connection lost after creating folder');
          }
        }
        if (made.mimeType === 'application/vnd.google-apps.document') {
          const text = boundary ? parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2) : '';
          documents.set(made.id, { title: made.name ?? '', text, revision: 1 });
          const marker = (body as { appProperties?: { nc_job_doc?: string } }).appProperties?.nc_job_doc;
          if (marker) markers.set(marker, made.id);
          if (loseCreateResponse) {
            loseCreateResponse = false;
            throw new TypeError('Connection lost after creating document');
          }
        }
        return Response.json({ ...made, id: nativeId, capabilities: { canShare: true } });
      }
      if (url.pathname === '/drive/v3/files') {
        const marker = /value='([^']+)'/u.exec(url.searchParams.get('q') ?? '')?.[1];
        const id = marker === undefined ? undefined : markers.get(marker);
        return Response.json({ files: id ? [{ id }] : [] });
      }
      if (url.pathname.includes('/permissions')) {
        if (init?.method === 'POST')
          return Response.json(await drive.createPermission(fileId, body as { emailAddress: string; role: 'reader' }));
        return Response.json({ permissions: await drive.listPermissions(fileId) });
      }
      if (url.pathname.endsWith('/comments')) return Response.json({ comments: await drive.listComments(fileId) });
      if (url.pathname.startsWith('/drive/v2/permissionIds/'))
        return Response.json({
          id: await drive.permissionId(decodeURIComponent(url.pathname.split('/').at(-1) ?? '')),
        });
      const file = hideFolders && folderIds.has(nativeFileId) ? undefined : await drive.getFile(fileId);
      return file
        ? Response.json({ ...file, id: nativeFileId, capabilities: { canShare: file.canShare } })
        : Response.json({}, { status: 404 });
    }),
  );
});
afterEach(async () => {
  await teardownChannelAdapters();
  await closeDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('creates in the job folder, records ownership, reads and edits through the host, and shares only with main-supplied members', async () => {
  const file = await made();
  const ownership = await getDb().get<{ folder_id: string }>(
    'SELECT f.folder_id FROM gws_ea_job_document_folders f JOIN gws_ea_job_documents d ON d.agent_group_id=f.agent_group_id WHERE d.file_id=?',
    file,
  );
  expect(drive.file(file)?.parents).toEqual([folderIds.get(ownership?.folder_id ?? '') ?? ownership?.folder_id]);
  const observed = accepted(await request(job, 'doc_read', { file }));
  expect(observed).toMatchObject({ text: 'Friday at the lake.', revision: 'r1' });
  accepted(await request(job, 'doc_edit', { file, revision: observed.revision, find: 'Friday', replace: 'Saturday' }));
  expect(documents.get(file)?.text).toBe('Saturday at the lake.');
  accepted(await request(job, 'doc_share', { file }));
  expect((await drive.listPermissions(file)).map((permission) => permission.emailAddress)).toContain(
    'mira@example.com',
  );
  expect(drive.writes.filter((call) => call.op === 'createPermission').map((call) => call.input)).toEqual([
    { type: 'user', emailAddress: 'mira@example.com', role: 'reader' },
  ]);
  expect(vi.mocked(hostGoogleAccessToken).mock.calls.every(([service]) => service === 'drive-host')).toBe(true);
});
it('refuses a first edit after a collaborator changes the observed document, then edits only after a new read', async () => {
  const file = await made();
  const observed = accepted(await request(job, 'doc_read', { file }));
  expect(observed).toMatchObject({ text: 'Friday at the lake.', revision: 'r1' });
  const collaboratorText = 'Friday at the lake. Bring a lake map.';
  documents.set(file, { title: 'Trip plan', text: collaboratorText, revision: 2 });
  const stale = await request(job, 'doc_edit', {
    file,
    revision: observed.revision,
    find: 'lake',
    replace: 'beach',
  });
  expect(refused(stale)).toContain('changed');
  expect(documents.get(file)).toEqual({ title: 'Trip plan', text: collaboratorText, revision: 2 });
  const current = accepted(await request(job, 'doc_read', { file }));
  expect(current).toMatchObject({ text: collaboratorText, revision: 'r2' });
  accepted(await request(job, 'doc_edit', { file, revision: current.revision, find: 'lake', replace: 'beach' }));
  expect(documents.get(file)).toEqual({
    title: 'Trip plan',
    text: 'Friday at the beach. Bring a beach map.',
    revision: 3,
  });
});
it.each([undefined, ''])('refuses an edit without a nonempty observed revision (%s)', async (revision) => {
  const file = await made();
  const reads = bodyReads.length;
  const result = await request(job, 'doc_edit', { file, revision, find: 'Friday', replace: 'Saturday' });
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'invalid-args', message: expect.stringContaining('revision') },
  });
  expect(bodyReads).toHaveLength(reads);
  expect(documents.get(file)).toEqual({ title: 'Trip plan', text: 'Friday at the lake.', revision: 1 });
});
it('returns readable content without an editable revision when Google omits its revision', async () => {
  const file = await made();
  omitRevision = true;
  const observed = accepted(await request(job, 'doc_read', { file }));
  expect(observed.text).toBe('Friday at the lake.');
  expect(observed).not.toHaveProperty('revision');
  const result = await request(job, 'doc_edit', { file, revision: 'r1', find: 'Friday', replace: 'Saturday' });
  expect(refused(result)).toContain('Google did not supply the revision');
  expect(documents.get(file)).toEqual({ title: 'Trip plan', text: 'Friday at the lake.', revision: 1 });
});
it('returns the actual created file ID and URL through the runner tool mailbox', async () => {
  const frame = await request(job, 'doc_create', { title: 'Trip plan', text: 'Friday at the lake.' });
  const data = accepted(frame);
  expect(typeof data.file).toBe('string');
  const runner = new URL('../../../container/agent-runner/src/', import.meta.url).href;
  const script = `
    await import(${JSON.stringify(`${runner}modules/index.ts`)});
    const { initTestSessionDb, getInboundDb, closeSessionDb } = await import(${JSON.stringify(`${runner}mailbox/sqlite/connection.ts`)});
    const { getUndeliveredMessages } = await import(${JSON.stringify(`${runner}db/messages-out.ts`)});
    const { docCreate } = await import(${JSON.stringify(`${runner}mcp-tools/gws-ea-chat-docs.ts`)});
    const frame = JSON.parse(await Bun.stdin.text());
    initTestSessionDb();
    try {
      const waiting = docCreate.handler({ title: 'Trip plan', text: 'Friday at the lake.' });
      while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
      const request = getUndeliveredMessages()[0];
      getInboundDb().prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)').run(
        'action-resp-' + request.id, 'system', new Date().toISOString(),
        JSON.stringify({ type: 'action_response', requestId: request.id, frame })
      );
      console.log(JSON.stringify(await waiting));
    } finally { closeSessionDb(); }
  `;
  const rendered: unknown = JSON.parse(
    execFileSync('bun', ['--eval', script], { input: JSON.stringify(frame), encoding: 'utf8', timeout: 5000 }),
  );
  expect(rendered).toMatchObject({
    content: [
      {
        type: 'text',
        text: expect.stringContaining(`https://docs.google.com/document/d/${String(data.file)}/edit`),
      },
    ],
  });
  accepted(await request(job, 'doc_share', { file: data.file }));
  expect((await drive.listPermissions(String(data.file))).map((permission) => permission.emailAddress)).toContain(
    'mira@example.com',
  );
});
it('shares and reads job documents from a native WhatsApp roster with only human member emails', async () => {
  const socket = new FakeSocket();
  socket.mappings.set('999000@lid', '15550000000@s.whatsapp.net');
  socket.groups.set('trip@g.us', {
    id: 'trip@g.us',
    owner: undefined,
    subject: 'Trip',
    participants: [{ id: '22@lid' }, { id: '11@lid' }, { id: socket.user.id }],
  });
  fs.mkdirSync(`${ROOT}/secrets`, { recursive: true, mode: 0o700 });
  const index = new WhatsAppIndex(`${ROOT}/secrets/whatsapp`, () => '15550000000@s.whatsapp.net');
  nativeGroups = createWhatsAppGroupEvents({
    socket: () => socket,
    index,
    link: () => ({
      schema_version: 1,
      state: 'connected',
      account: { lid: '999000', phoneJid: '15550000000@s.whatsapp.net' },
      principal: { lid: '11' },
    }),
  });
  try {
    const file = await made();
    accepted(await request(job, 'doc_share', { file }));
    expect((await drive.listPermissions(file)).map((permission) => permission.emailAddress)).toEqual([
      'assistant@example.com',
      'mira@example.com',
    ]);
    const outside = await outsideFile();
    await drive.createPermission(outside, { emailAddress: 'mira@example.com', role: 'reader' });
    expect(accepted(await request(job, 'doc_read', { file: outside })).text).toContain('Everyone may read this.');
    expect(
      await getDb().all<{ member_key: string }>(
        "SELECT member_key FROM gws_ea_chat_members WHERE messaging_group_id='trip' ORDER BY member_key",
      ),
    ).toEqual([{ member_key: 'whatsapp:11' }, { member_key: 'whatsapp:22' }]);
  } finally {
    nativeGroups = undefined;
    index.close();
  }
});
it('checks each fresh member before reading a document it did not make', async () => {
  const file = await outsideFile();
  expect(refused(await request(job, 'doc_read', { file }))).toContain('main');
  expect(bodyReads).not.toContain(file);
  await drive.createPermission(file, { emailAddress: 'mira@example.com', role: 'reader' });
  expect(accepted(await request(job, 'doc_read', { file })).text).toContain('Everyone may read this.');
  members.push({ key: 'whatsapp:33', isPrincipal: false });
  expect(refused(await request(job, 'doc_read', { file }))).toContain('email');
  await setChatMemberEmail('trip', 'whatsapp:33', 'new@example.com', 'member');
  expect(refused(await request(job, 'doc_read', { file }))).toContain('main');
  await setChatMemberEmail('trip', 'whatsapp:33', 'new@example.com', 'main');
  expect(refused(await request(job, 'doc_read', { file }))).toContain('main');
  await drive.createPermission(file, { emailAddress: 'new@example.com', role: 'reader' });
  expect(accepted(await request(job, 'doc_read', { file })).text).toContain('Everyone may read this.');
});
it('refuses edit/share on an accessible outside file and every document action from external-chat', async () => {
  const file = await outsideFile();
  await drive.createPermission(file, { emailAddress: 'mira@example.com', role: 'reader' });
  for (const action of ['doc_edit', 'doc_share'])
    expect(
      refused(
        await request(job, action, {
          file,
          ...(action === 'doc_edit'
            ? { revision: await observedRevision(file), find: 'Everyone', replace: 'Nobody' }
            : {}),
        }),
      ),
    ).toContain('made for this job');
  for (const action of ['doc_create', 'doc_read', 'doc_edit', 'doc_share'])
    expect(refused(await request(external, action, {}))).toContain('job');
  expect(JOB_DOCUMENT_ACTIONS.map(([name]) => name)).toEqual(['doc_create', 'doc_read', 'doc_edit', 'doc_share']);
});
it('keeps private values behind the existing matcher on writes and new shares, honoring only this chat’s clearance', async () => {
  const hidden = await addPrivateValue({ kind: 'address', value: '123 Secret Lane', label: 'Home' });
  expect(refused(await request(job, 'doc_create', { title: 'Trip plan', text: '123 Secret Lane' }))).toContain(
    'private address',
  );
  expect(documents.size).toBe(0);
  const file = await made();
  expect(
    refused(
      await request(job, 'doc_edit', {
        file,
        revision: await observedRevision(file),
        find: 'the lake',
        replace: '123 Secret Lane',
      }),
    ),
  ).toContain('private address');
  expect(documents.get(file)?.text).toBe('Friday at the lake.');
  documents.set(file, { title: 'Trip plan', text: '123 Secret Lane', revision: 3 });
  expect(refused(await request(job, 'doc_share', { file }))).toContain('private address');
  await getDb().run(
    'INSERT INTO gws_ea_chat_clearances(messaging_group_id,private_value_id,principal_message_id,cleared_at) VALUES(?,?,?,?)',
    'other',
    hidden.id,
    'principal-mark',
    new Date().toISOString(),
  );
  expect(refused(await request(job, 'doc_share', { file }))).toContain('private address');
  await getDb().run(
    'INSERT INTO gws_ea_chat_clearances(messaging_group_id,private_value_id,principal_message_id,cleared_at) VALUES(?,?,?,?)',
    'trip',
    hidden.id,
    'principal-mark',
    new Date().toISOString(),
  );
  accepted(await request(job, 'doc_share', { file }));
});
it.each(['anyone', 'group', 'domain', 'user'])(
  'does not apply a chat clearance to a job document with outside %s readers',
  async (type) => {
    const hidden = await addPrivateValue({ kind: 'address', value: '123 Secret Lane', label: 'Home' });
    const file = await made();
    await getDb().run(
      'INSERT INTO gws_ea_chat_clearances(messaging_group_id,private_value_id,principal_message_id,cleared_at) VALUES(?,?,?,?)',
      'trip',
      hidden.id,
      'principal-mark',
      new Date().toISOString(),
    );
    drive.share(file, { id: 'outside', type, role: 'reader', emailAddress: 'outside@example.com' });
    expect(
      refused(
        await request(job, 'doc_edit', {
          file,
          revision: await observedRevision(file),
          find: 'the lake',
          replace: '123 Secret Lane',
        }),
      ),
    ).toContain('private address');
    expect(documents.get(file)?.text).toBe('Friday at the lake.');
    documents.set(file, { title: 'Trip plan', text: '123 Secret Lane', revision: 3 });
    expect(refused(await request(job, 'doc_share', { file }))).toContain('private address');
  },
);
it('does not make ordinary edits depend on a document having a narrow access list', async () => {
  const file = await made();
  drive.share(file, { id: 'public', type: 'anyone', role: 'reader' });
  accepted(
    await request(job, 'doc_edit', { file, revision: await observedRevision(file), find: 'Friday', replace: 'Sunday' }),
  );
  expect(documents.get(file)?.text).toBe('Sunday at the lake.');
  accepted(await request(job, 'doc_share', { file }));
});
it.each(['reply', 'quote'])(
  'checks private details in a document comment’s %s before granting a member access',
  async (where) => {
    await addPrivateValue({ kind: 'address', value: '123 Secret Lane', label: 'Home' });
    const file = await made();
    drive.comment(file, {
      id: 'comment',
      content: 'Where do we meet?',
      ...(where === 'reply'
        ? { replies: [{ content: '123 Secret Lane' }] }
        : { quotedFileContent: { mimeType: 'text/plain', value: '123 Secret Lane' } }),
    });
    expect(refused(await request(job, 'doc_share', { file }))).toContain('private address');
    expect((await drive.listPermissions(file)).map((permission) => permission.emailAddress)).not.toContain(
      'mira@example.com',
    );
  },
);
it('refuses a hidden Google link that members cannot open before an edit or a new share exposes it', async () => {
  const privateFile = await outsideFile();
  const file = await made();
  const link = `https://docs.google.com/document/d/${privateFile}/edit`;
  expect(
    refused(
      await request(job, 'doc_edit', { file, revision: await observedRevision(file), find: 'the lake', replace: link }),
    ),
  ).toContain('main');
  expect(documents.get(file)?.text).toBe('Friday at the lake.');
  documents.set(file, { title: 'Trip plan', text: link, revision: 3 });
  expect(refused(await request(job, 'doc_share', { file }))).toContain('main');
  await drive.createPermission(privateFile, { emailAddress: 'mira@example.com', role: 'reader' });
  accepted(await request(job, 'doc_share', { file }));
});
it('replays a completed create without creating twice after its mailbox answer is lost', async () => {
  const createFields = { title: 'Trip plan', text: 'lake' };
  const first = accepted(await request(job, 'doc_create', createFields, 'same-create'));
  loseAnswer(job, 'same-create');
  expect(accepted(await request(job, 'doc_create', createFields, 'same-create')).file).toBe(first.file);
  expect(documents.get(String(first.file))?.text).toBe('lake');
  expect(documents.size).toBe(1);
});
it('does not apply an overlapping replacement twice if only the mailbox answer is lost', async () => {
  const file = await made();
  const fields = { file, revision: await observedRevision(file), find: 'lake', replace: 'lake lake' };
  accepted(await request(job, 'doc_edit', fields, 'edit-replayed'));
  loseAnswer(job, 'edit-replayed');
  accepted(await request(job, 'doc_edit', fields, 'edit-replayed'));
  expect(documents.get(file)?.text).toBe('Friday at the lake lake.');
});
it('refuses a replay that swaps the original edit revision for a newer read', async () => {
  const file = await made();
  const fields = { file, revision: await observedRevision(file), find: 'lake', replace: 'lake lake' };
  accepted(await request(job, 'doc_edit', fields, 'changed-edit-revision'));
  loseAnswer(job, 'changed-edit-revision');
  const newerRevision = await observedRevision(file);
  expect(newerRevision).not.toBe(fields.revision);
  const changed = await request(job, 'doc_edit', { ...fields, revision: newerRevision }, 'changed-edit-revision');
  expect(refused(changed)).toContain('different work');
  expect(documents.get(file)?.text).toBe('Friday at the lake lake.');
});
it('recovers an ambiguous create by its scoped native marker without issuing a second create', async () => {
  loseCreateResponse = true;
  const fields = { title: 'Trip plan', text: 'Friday' };
  expect(refused(await request(job, 'doc_create', fields, 'ambiguous-create'))).toContain('unconfirmed');
  const file = [...documents.keys()][0];
  loseAnswer(job, 'ambiguous-create');
  expect(accepted(await request(job, 'doc_create', fields, 'ambiguous-create')).file).toBe(file);
  expect(documents.size).toBe(1);
  expect(await getDb().get('SELECT file_id FROM gws_ea_job_documents WHERE file_id=?', file)).toBeDefined();
});
it('keeps a started create unconfirmed when Google cannot find its marker, without creating again', async () => {
  loseCreateResponse = true;
  const fields = { title: 'Trip plan', text: 'Friday' };
  expect(refused(await request(job, 'doc_create', fields, 'missing-create'))).toContain('unconfirmed');
  markers.clear();
  loseAnswer(job, 'missing-create');
  expect(refused(await request(job, 'doc_create', fields, 'missing-create'))).toContain('unconfirmed');
  expect(documents.size).toBe(1);
});
it('reports an ambiguous edit honestly when its recorded revision has changed instead of applying it twice', async () => {
  const file = await made();
  loseEditResponse = true;
  const fields = { file, revision: await observedRevision(file), find: 'lake', replace: 'lake lake' };
  expect(refused(await request(job, 'doc_edit', fields, 'ambiguous-edit'))).toContain('unconfirmed');
  loseAnswer(job, 'ambiguous-edit');
  expect(refused(await request(job, 'doc_edit', fields, 'ambiguous-edit'))).toContain('unconfirmed');
  expect(documents.get(file)?.text).toBe('Friday at the lake lake.');
});
it('shares with freshly joined members only after main supplies their emails, including the principal when supplied', async () => {
  const file = await made();
  members.push({ key: 'whatsapp:33', isPrincipal: false });
  expect(refused(await request(job, 'doc_share', { file }))).toContain('email');
  expect(drive.writes.filter((call) => call.op === 'createPermission')).toHaveLength(0);
  await setChatMemberEmail('trip', 'whatsapp:33', 'new@example.com', 'member');
  expect(refused(await request(job, 'doc_share', { file }))).toContain('main');
  await setChatMemberEmail('trip', 'whatsapp:33', 'new@example.com', 'main');
  drive.addAccount('juno@example.com');
  await setChatMemberEmail('trip', 'whatsapp:11', 'juno@example.com', 'main');
  accepted(await request(job, 'doc_share', { file }));
  expect((await drive.listPermissions(file)).map((permission) => permission.emailAddress)).toEqual(
    expect.arrayContaining(['mira@example.com', 'new@example.com', 'juno@example.com']),
  );
});
it('lets a cleared private write reach verified principal and assistant accounts without exposing their addresses to the job', async () => {
  const hidden = await addPrivateValue({ kind: 'address', value: '123 Secret Lane', label: 'Home' });
  await addPrincipalAddress('juno@example.com');
  drive.addAccount('juno@example.com');
  const file = await made();
  await drive.createPermission(file, { emailAddress: 'juno@example.com', role: 'writer' });
  await getDb().run(
    'INSERT INTO gws_ea_chat_clearances(messaging_group_id,private_value_id,principal_message_id,cleared_at) VALUES(?,?,?,?)',
    'trip',
    hidden.id,
    'principal-mark',
    new Date().toISOString(),
  );
  const result = await request(job, 'doc_edit', {
    file,
    revision: await observedRevision(file),
    find: 'the lake',
    replace: '123 Secret Lane',
  });
  expect(accepted(result)).toEqual({ file, message: 'The document was edited.' });
  expect(JSON.stringify(result)).not.toContain('juno@example.com');
  expect(JSON.stringify(result)).not.toContain('assistant@example.com');
});
it('reuses one native job folder after its creation acknowledgement is lost', async () => {
  loseFolderResponse = true;
  const fields = { title: 'Trip plan', text: 'Friday' };
  const first = await request(job, 'doc_create', fields, 'lost-folder');
  expect(refused(first)).toContain('unconfirmed');
  expect(documents.size).toBe(0);
  expect(folderCreates).toHaveLength(1);
  expect(folderReservations).toEqual([folderCreates[0].id]);
  loseAnswer(job, 'lost-folder');
  accepted(await request(job, 'doc_create', fields, 'lost-folder'));
  expect(folderCreates).toHaveLength(1);
  const recorded = await getDb().get<{ folder_id: string }>(
    'SELECT folder_id FROM gws_ea_job_document_folders WHERE agent_group_id=?',
    'job',
  );
  expect(recorded?.folder_id).toBe(folderCreates[0].id);
});
it('resumes a reserved folder ID when the host stopped before sending the create', async () => {
  const id = await generateDriveFileId({ token: async () => 'host-only-token' });
  await getDb().run(
    'INSERT INTO gws_ea_job_document_folders(agent_group_id,folder_id,created_at) VALUES(?,?,?)',
    'job',
    id,
    new Date().toISOString(),
  );
  await made();
  expect(folderCreates).toEqual([expect.objectContaining({ id, name: 'Documents' })]);
  expect(generatedFolderIds).toBe(1);
});
it('names the visible job folder without exposing an internal agent identifier', async () => {
  await made();
  expect(folderCreates[0].name).toBe('Documents');
});
it('keeps an ambiguous folder under the same reserved ID when Drive cannot confirm its existence', async () => {
  loseFolderResponse = true;
  const fields = { title: 'Trip plan', text: 'Friday' };
  expect(refused(await request(job, 'doc_create', fields, 'unconfirmed-folder'))).toContain('unconfirmed');
  hideFolders = true;
  loseAnswer(job, 'unconfirmed-folder');
  expect(refused(await request(job, 'doc_create', fields, 'unconfirmed-folder'))).toContain('unconfirmed');
  expect(folderCreates).toHaveLength(1);
  expect(generatedFolderIds).toBe(1);
  expect(documents.size).toBe(0);
});
it('checks artifact-only links before an edit or a document share exposes them', async () => {
  const file = await made();
  enableArtifacts();
  const link = 'https://views.example.com/aya/share/11111111-1111-4111-8111-111111111111';
  expect(
    refused(
      await request(job, 'doc_edit', { file, revision: await observedRevision(file), find: 'the lake', replace: link }),
    ),
  ).toContain('artifact access');
  expect(documents.get(file)?.text).toBe('Friday at the lake.');
  documents.set(file, { title: 'Trip plan', text: link, revision: 3 });
  expect(refused(await request(job, 'doc_share', { file }))).toContain('artifact access');
});

it('allows private artifact links beside Google links for a native principal-only document audience', async () => {
  const file = await made();
  const artifact = await privateArtifactLink();
  const google = `https://docs.google.com/document/d/${await outsideFile()}/edit`;
  members = [{ key: 'whatsapp:11', isPrincipal: true }];
  accepted(
    await request(job, 'doc_edit', {
      file,
      revision: await observedRevision(file),
      find: 'the lake',
      replace: `${artifact} ${google}`,
    }),
  );
  expect(documents.get(file)?.text).toBe(`Friday at ${artifact} ${google}.`);
  accepted(await request(job, 'doc_share', { file }));
});
it.each([false, true])(
  'refuses private artifact links for a non-principal assigned a principal email (Google link: %s)',
  async (mixed) => {
    const file = await made();
    const artifact = await privateArtifactLink();
    await setChatMemberEmail('trip', 'whatsapp:22', 'principal@example.com', 'main');
    const replacement = mixed ? `${artifact} https://docs.google.com/document/d/${await outsideFile()}/edit` : artifact;
    expect(
      refused(
        await request(job, 'doc_edit', {
          file,
          revision: await observedRevision(file),
          find: 'the lake',
          replace: replacement,
        }),
      ),
    ).toContain('artifact access');
    expect(documents.get(file)?.text).toBe('Friday at the lake.');
    documents.set(file, { title: 'Trip plan', text: replacement, revision: 3 });
    expect(refused(await request(job, 'doc_share', { file }))).toContain('artifact access');
    expect(drive.writes.filter((call) => call.op === 'createPermission')).toEqual([]);
  },
);
