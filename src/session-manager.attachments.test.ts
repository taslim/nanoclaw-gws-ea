/**
 * Security regression for the channel-inbound attachment path (#2828 sibling).
 *
 * `extractAttachmentFiles` (via `writeSessionMessage`) hardens the per-message
 * inbox subdir against pre-placed symlinks, but NOT the `inbox` root itself.
 * A compromised container can write inside its own session dir, so it can
 * replace `inbox` with a symlink pointing outside the session sandbox. The
 * existing guard then:
 *   - skips the lstat branch (it only lstats `inbox/<msgId>`, not `inbox`),
 *   - mkdirs `inbox/<msgId>` *through* the symlink,
 *   - passes the containment check, because it compares against
 *     `realpathSync(inboxRoot)` which has already followed the symlink, and
 *   - writes a brand-new file (the `wx` flag only blocks an existing dst).
 *
 * Result: the host writes attacker-influenced bytes outside the session root —
 * the same class of bug fixed for the A2A path in forwardAttachedFiles (#2828).
 *
 * This test asserts the SECURE behaviour (nothing written outside). It FAILS
 * against the current code, demonstrating the gap.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-saveatt-gap' };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { createSession } from './db/sessions.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { initSessionFolder, sessionDir, writeSessionMessage } from './session-manager.js';
import type { Session } from './types.js';

const TEST_DIR = '/tmp/nanoclaw-test-saveatt-gap';
const AG = 'ag-saveatt';
const SESS = 'sess-saveatt';

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: AG, name: 'SaveAtt', folder: 'saveatt', agent_provider: null, created_at: now() });
  const sess: Session = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(sess);
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('extractAttachmentFiles — inbox-root symlink containment (#2828 sibling)', () => {
  it('does not write an attachment outside the session root via a symlinked inbox root', async () => {
    // Attacker-controlled location outside the session sandbox.
    const canaryDir = path.join(TEST_DIR, 'canary-outside');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Container pre-places its whole `inbox` as a symlink pointing outside.
    const inboxRoot = path.join(sessionDir(AG, SESS), 'inbox');
    fs.rmSync(inboxRoot, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, inboxRoot);

    const content = JSON.stringify({
      text: 'see attached',
      attachments: [{ name: 'pwn.txt', data: Buffer.from('attacker-bytes').toString('base64') }],
    });

    await writeSessionMessage(AG, SESS, {
      id: 'evil-inbox-root',
      kind: 'chat',
      timestamp: now(),
      platformId: 'whatsapp:123',
      channelType: 'whatsapp',
      threadId: null,
      content,
    });

    // SECURE expectation: nothing was written through the symlink to the
    // attacker-controlled canary location.
    const escaped = path.join(canaryDir, 'evil-inbox-root', 'pwn.txt');
    expect(fs.existsSync(escaped)).toBe(false);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
  });
});

describe('extractAttachmentFiles — a platform message ID that is not a file name', () => {
  const GCHAT_ID = 'spaces/AAAA/messages/BBBB.BBBB';

  function storedContent(id: string): Record<string, unknown> {
    const inbound = new Database(inboundDbPath(AG, SESS), { readonly: true });
    const row = inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get(id) as { content: string };
    inbound.close();
    return JSON.parse(row.content) as Record<string, unknown>;
  }

  it('saves the attachment in a folder named for a hash of the ID, and points the message at it', async () => {
    const content = JSON.stringify({
      text: 'the agenda',
      attachments: [{ name: 'agenda.txt', data: Buffer.from('agenda bytes').toString('base64') }],
    });

    await writeSessionMessage(AG, SESS, {
      id: GCHAT_ID,
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'gchat:spaces/AAAA',
      channelType: 'gchat',
      threadId: null,
      content,
    });

    const folder = `msg-${createHash('sha256').update(GCHAT_ID).digest('hex').slice(0, 32)}`;
    const stored = storedContent(GCHAT_ID);
    expect(stored.attachments).toEqual([{ name: 'agenda.txt', localPath: `inbox/${folder}/agenda.txt` }]);
    expect(fs.readFileSync(path.join(sessionDir(AG, SESS), 'inbox', folder, 'agenda.txt'), 'utf8')).toBe(
      'agenda bytes',
    );
  });

  it('leaves a message with no attachment bytes as it was, creating no folder', async () => {
    const content = JSON.stringify({ text: 'hello', attachments: [] });

    await writeSessionMessage(AG, SESS, {
      id: GCHAT_ID,
      kind: 'chat-sdk',
      timestamp: now(),
      platformId: 'gchat:spaces/AAAA',
      channelType: 'gchat',
      threadId: null,
      content,
    });

    expect(storedContent(GCHAT_ID)).toEqual({ text: 'hello', attachments: [] });
    const inbox = path.join(sessionDir(AG, SESS), 'inbox');
    expect(fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).toEqual([]);
  });
});
