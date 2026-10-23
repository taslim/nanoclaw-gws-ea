import { afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import type { ArtifactPreviewInput } from '../artifacts/preview.js';
const previews: ArtifactPreviewInput[] = [];
mock.module('../artifacts/preview.js', () => ({
  previewArtifact: async (input: ArtifactPreviewInput) => {
    previews.push(input);
    return {
      status: 'previewed',
      sourceHash: 'a'.repeat(64),
      images: [{ viewport: 'desktop', mode: 'static', mimeType: 'image/png', data: 'cG5n' }],
      diagnostics: {
        errors: [],
        blockedRequests: [],
        horizontalOverflow: [],
        chromiumMajor: 150,
        interactionAvailable: false,
      },
    };
  },
}));
const { artifactSave, artifactPreview } = await import('./gws-ea-artifacts.js');
let root: string;
let spies: { mockRestore: () => void }[] = [];
beforeEach(() => {
  initTestSessionDb();
  previews.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-tool-'));
  for (const folder of ['agent', 'inbox', 'outbox']) fs.mkdirSync(path.join(root, folder));
  fs.writeFileSync(path.join(root, 'agent', 'draft.html'), '<p>Useful facts</p>');
  const local = (target: fs.PathLike) =>
    String(target).startsWith('/workspace/') ? path.join(root, String(target).slice('/workspace/'.length)) : target;
  const open = fs.openSync,
    mkdir = fs.mkdirSync,
    write = fs.writeFileSync;
  spies = [
    spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) =>
      open(local(target), flags, mode)) as typeof fs.openSync),
    spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) =>
      mkdir(local(target), options)) as typeof fs.mkdirSync),
    spyOn(fs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      ...args: Parameters<typeof fs.writeFileSync> extends [unknown, ...infer Rest] ? Rest : never
    ) => write(typeof target === 'number' ? target : local(target), ...args)) as typeof fs.writeFileSync),
  ];
});
afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  closeSessionDb();
  fs.rmSync(root, { recursive: true, force: true });
});
async function answer(data: Record<string, unknown>, ok = true) {
  for (let attempt = 0; attempt < 1000 && getUndeliveredMessages().length === 0; attempt++) await Bun.sleep(1);
  const row = getUndeliveredMessages()[0];
  if (!row) throw new Error('No native request was written');
  getInboundDb()
    .prepare('INSERT INTO messages_in(id,kind,timestamp,content,trigger) VALUES(?,?,?,?,0)')
    .run(
      `action-resp-${row.id}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({
        type: 'action_response',
        requestId: row.id,
        frame: ok
          ? { id: row.id, ok: true, data }
          : { id: row.id, ok: false, error: { code: 'forbidden', message: 'Capability disabled' } },
      }),
    );
  return JSON.parse(row.content) as Record<string, unknown>;
}
it('stages bounded source through file reads without shell and sends only the declared staged filename', async () => {
  const waiting = artifactSave.handler({
    create_key: 'report',
    title: 'Report',
    file: 'draft.html',
    author_group_id: 'forged',
  });
  const sent = await answer({ artifact_id: 'saved' });
  expect(sent).toEqual({
    action: 'artifact_save',
    requestId: expect.any(String),
    create_key: 'report',
    title: 'Report',
    file: 'artifact.html',
  });
  expect(fs.readFileSync(path.join(root, 'outbox', String(sent.requestId), 'artifact.html'), 'utf8')).toBe(
    '<p>Useful facts</p>',
  );
  expect((await waiting).isError).toBeUndefined();
});
it('refuses sources outside the mounts, symlink files and oversized sources before sending a request', async () => {
  fs.symlinkSync(path.join(root, 'agent', 'draft.html'), path.join(root, 'inbox', 'linked.html'));
  fs.writeFileSync(path.join(root, 'agent', 'large.html'), '');
  fs.truncateSync(path.join(root, 'agent', 'large.html'), 4 * 1024 * 1024 + 1);
  for (const file of ['/etc/passwd', '/workspace/inbox/linked.html', 'large.html'])
    expect((await artifactSave.handler({ create_key: 'key', title: 'Report', file })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
});

it('refuses invalid UTF-8 and a source that grows while it is read', async () => {
  const file = path.join(root, 'agent', 'draft.html');
  fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
  expect((await artifactSave.handler({ create_key: 'key', title: 'Report', file: 'draft.html' })).isError).toBe(true);
  fs.writeFileSync(file, '<p>Original</p>');
  const read = fs.readSync;
  const changed = spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const count = read(...args);
    fs.appendFileSync(file, 'x');
    return count;
  }) as typeof fs.readSync);
  spies.push(changed);
  expect((await artifactSave.handler({ create_key: 'key', title: 'Report', file: 'draft.html' })).isError).toBe(true);
  expect(getUndeliveredMessages()).toHaveLength(0);
});
it('checks live authorization before reading or rendering a draft and renders nothing after denial', async () => {
  const waiting = artifactPreview.handler({ file: 'draft.html' });
  expect(previews).toHaveLength(0);
  expect((await answer({}, false)).action).toBe('artifact_preview_authorize');
  expect((await waiting).isError).toBe(true);
  expect(previews).toHaveLength(0);
});

it('spends the same 15-second preview deadline on stalled host authorization before any rendering', async () => {
  const deadline = new AbortController();
  const cancel = new AbortController();
  const timeout = AbortSignal.timeout;
  const timeouts: number[] = [];
  spies.push(
    spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      timeouts.push(milliseconds);
      return milliseconds === 15_000 ? deadline.signal : timeout(milliseconds);
    }),
  );
  const waiting = artifactPreview.handler({ file: 'draft.html' }, { signal: cancel.signal });
  for (let attempt = 0; attempt < 1000 && getUndeliveredMessages().length === 0; attempt++) await Bun.sleep(1);
  expect(getUndeliveredMessages()).toHaveLength(1);
  deadline.abort(new DOMException('Preview deadline', 'TimeoutError'));
  await Bun.sleep(5);
  cancel.abort();
  const result = await waiting;
  expect(timeouts).toContain(15_000);
  expect(result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: expect.stringContaining('15-second deadline') }],
  });
  expect(previews).toHaveLength(0);
});
it('returns preview captures as native MCP images and binds the renderer to its authenticated session', async () => {
  const waiting = artifactPreview.handler({ file: 'draft.html', expected_hash: 'a'.repeat(64) });
  await answer({ authorized: true, session_id: 'authenticated-session' });
  const result = await waiting;
  expect(previews[0]).toMatchObject({
    sessionId: 'authenticated-session',
    html: '<p>Useful facts</p>',
    expectedHash: 'a'.repeat(64),
  });
  expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'cG5n' });
  expect(result.content[0]).not.toHaveProperty('data');
});
