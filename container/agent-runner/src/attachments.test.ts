import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { gatherInlineAttachments } from './attachments.js';
import type { MessageInRow } from './db/messages-in.js';

const ALL_NATIVE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);

let workspace: string;
let inbox: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
  inbox = path.join(workspace, 'inbox', 'msg-1');
  fs.mkdirSync(inbox, { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function row(content: unknown): MessageInRow {
  return {
    id: 'r1',
    seq: 1,
    kind: 'chat',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    sender: null,
    content: JSON.stringify(content),
    timestamp: new Date().toISOString(),
    trigger: 1,
    in_reply_to: null,
    metadata: null,
    status: 'pending',
    tries: 0,
    received_at: new Date().toISOString(),
  } as unknown as MessageInRow;
}

describe('gatherInlineAttachments', () => {
  test('inlines PDFs and images, skips unsupported types', async () => {
    const pdfPath = 'inbox/msg-1/foo.pdf';
    const pngPath = 'inbox/msg-1/bar.png';
    const txtPath = 'inbox/msg-1/baz.txt';
    fs.writeFileSync(path.join(workspace, pdfPath), Buffer.from('PDFBYTES'));
    fs.writeFileSync(path.join(workspace, pngPath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(workspace, txtPath), 'plain text');

    const r = row({
      text: 'see attached',
      attachments: [
        { name: 'foo.pdf', mimeType: 'application/pdf', localPath: pdfPath },
        { name: 'bar.png', mimeType: 'image/png', localPath: pngPath },
        { name: 'baz.txt', mimeType: 'text/plain', localPath: txtPath },
      ],
    });

    const { blocks, inlinedPaths } = await gatherInlineAttachments([r], ALL_NATIVE, workspace);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
      title: 'foo.pdf',
    });
    expect(blocks[1]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
    expect(inlinedPaths.has(pdfPath)).toBe(true);
    expect(inlinedPaths.has(pngPath)).toBe(true);
    expect(inlinedPaths.has(txtPath)).toBe(false);
  });

  test('returns empty when provider supports nothing', async () => {
    const p = 'inbox/msg-1/foo.pdf';
    fs.writeFileSync(path.join(workspace, p), 'X');
    const r = row({ attachments: [{ name: 'foo.pdf', mimeType: 'application/pdf', localPath: p }] });

    const result = await gatherInlineAttachments([r], new Set<string>(), workspace);

    expect(result.blocks).toHaveLength(0);
    expect(result.inlinedPaths.size).toBe(0);
  });

  test('refuses localPath that escapes workspace', async () => {
    const escape = '../etc/passwd';
    const r = row({ attachments: [{ name: 'evil', mimeType: 'application/pdf', localPath: escape }] });

    const { blocks } = await gatherInlineAttachments([r], ALL_NATIVE, workspace);

    expect(blocks).toHaveLength(0);
  });

  test('drops attachments larger than the per-block cap', async () => {
    const big = 'inbox/msg-1/big.pdf';
    fs.writeFileSync(path.join(workspace, big), Buffer.alloc(31 * 1024 * 1024));
    const r = row({ attachments: [{ name: 'big.pdf', mimeType: 'application/pdf', localPath: big }] });

    const { blocks } = await gatherInlineAttachments([r], ALL_NATIVE, workspace);

    expect(blocks).toHaveLength(0);
  });

  test('handles all four image mime types', async () => {
    const types: Array<['image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', string]> = [
      ['image/jpeg', 'a.jpg'],
      ['image/png', 'b.png'],
      ['image/gif', 'c.gif'],
      ['image/webp', 'd.webp'],
    ];
    const attachments = types.map(([mime, name]) => {
      const p = `inbox/msg-1/${name}`;
      fs.writeFileSync(path.join(workspace, p), 'X');
      return { name, mimeType: mime, localPath: p };
    });

    const { blocks } = await gatherInlineAttachments([row({ attachments })], ALL_NATIVE, workspace);

    expect(blocks.map((b) => b.source.media_type).sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  });

  test('case-insensitive mime matching', async () => {
    const p = 'inbox/msg-1/foo.PDF';
    fs.writeFileSync(path.join(workspace, p), 'X');
    const r = row({ attachments: [{ name: 'foo.PDF', mimeType: 'Application/PDF', localPath: p }] });

    const { blocks } = await gatherInlineAttachments([r], ALL_NATIVE, workspace);

    expect(blocks).toHaveLength(1);
  });

  test('skips attachments with no localPath (bare base64 data not yet extracted)', async () => {
    const r = row({ attachments: [{ name: 'foo.pdf', mimeType: 'application/pdf', data: 'JVBE...' }] });

    const { blocks } = await gatherInlineAttachments([r], ALL_NATIVE, workspace);

    expect(blocks).toHaveLength(0);
  });
});
