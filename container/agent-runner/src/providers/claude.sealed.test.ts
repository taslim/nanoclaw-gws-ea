/**
 * Sealed sessions on the Claude provider (memory/sealed.ts): a group without
 * `conversation-context` archives no transcript into its conversations/,
 * neither when the SDK compacts nor when a long transcript is rotated. A
 * group holding the key archives as it always has.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

interface CapturedOptions {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}
let captured: CapturedOptions | undefined;

const pinnedSdk = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...pinnedSdk,
  query: (args: { options?: CapturedOptions }) => {
    captured = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));

let grants: ReadonlySet<string> = new Set();
const actualConfig = await import('../config.js');
mock.module('../config.js', () => ({ ...actualConfig, runnerCapabilities: () => grants }));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK, SEALED_MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

/** What a group on `all` holds, conversation-context among it. */
const ALL = ['reply', 'files-read', 'files-write', 'shell', 'conversation-context'];
/** external-email's list: no conversation-context, so its sessions are sealed. */
const SEALED = ['files-read', 'time', 'request-status', 'gws-ea-reminders', 'gws-ea-email-external'];

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sealed-'));
  captured = undefined;
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'NANOCLAW_CONVERSATIONS_DIR', 'CLAUDE_TRANSCRIPT_ROTATE_BYTES']) {
    saved[key] = process.env[key];
  }
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function hooksFor(keys: readonly string[]): Promise<Record<string, unknown>> {
  grants = new Set(keys);
  const provider = createProvider('claude', { env: { PATH: process.env.PATH } });
  provider.registerMemorySessionHook(keys.includes('conversation-context') ? MEMORY_SESSION_HOOK : SEALED_MEMORY_SESSION_HOOK);
  for await (const _event of provider.query({ prompt: 'go', cwd: tmp }).events) {
    // Drain the stub stream so the provider has called the SDK.
  }
  if (!captured?.hooks) throw new Error('the provider gave the SDK no hooks');
  return captured.hooks;
}

/** A transcript over the rotation limit, with one exchange the archive would keep. */
function oversizedTranscript(sessionId: string): string {
  const dir = path.join(tmp, '.claude', 'projects', '-workspace-agent');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Find us a time.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Wednesday at 10.' }] } },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n${'x'.repeat(200 * 1024)}`);
  return file;
}

function rotate(keys: readonly string[], sessionId: string): string | null {
  grants = new Set(keys);
  process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
  oversizedTranscript(sessionId);
  return createProvider('claude').maybeRotateContinuation!(sessionId, '/workspace/agent');
}

function archived(): string[] {
  const dir = path.join(tmp, 'conversations');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

describe('the Claude provider for a sealed session', () => {
  it('registers no PreCompact archive, and a group holding conversation-context still does', async () => {
    const sealed = await hooksFor(SEALED);
    expect(sealed.PreCompact).toBeUndefined();
    expect(sealed.PreToolUse).toBeDefined();

    expect(await hooksFor(ALL)).toHaveProperty('PreCompact');
  });

  it('rotates a long transcript without archiving it, and archives it for a group holding the key', () => {
    expect(rotate(SEALED, 'sess-sealed')).not.toBeNull();
    expect(archived()).toEqual([]);

    expect(rotate(ALL, 'sess-shared')).not.toBeNull();
    expect(archived().length).toBe(1);
  });
});
