import { describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';

import { buildCompactInstructions } from './compact-instructions.js';

const HOOK = path.join(import.meta.dir, 'compact-instructions.ts');
const SESSION_FIXTURE = path.join(import.meta.dir, 'test-utils', 'hook-session-fixture.ts');
/** The wording without `reply`: no container.json is readable outside a container. */
const NO_CAPABILITIES: ReadonlySet<string> = new Set();

/**
 * Runs the PreCompact hook as Claude Code does: its own bun process, given the
 * hook input on stdin. The test preload that registers the mailbox for every
 * `bun test` file is not loaded; the only preload seeds the session's inbound
 * mailbox. The child runs outside the runner tree, so no bunfig there applies.
 */
async function runHook(fixture: { destinations: string[]; threadId?: string }) {
  const proc = Bun.spawn([process.execPath, '--preload', SESSION_FIXTURE, HOOK], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      HOOK_FIXTURE_DESTINATIONS: fixture.destinations.join(','),
      ...(fixture.threadId ? { HOOK_FIXTURE_THREAD_ID: fixture.threadId } : {}),
    },
    stdin: new Blob([JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', session_id: 'session-a' })]),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Drain both pipes while waiting: a child that fills a pipe buffer blocks until it is read.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: proc.exitCode, stdout, stderr };
}

describe('PreCompact hook script', () => {
  it("prints the chat session's compaction instructions with its destinations, and exits 0", async () => {
    const result = await runHook({ destinations: ['inbox', 'morgan-ellery'] });

    expect(result.stderr).not.toContain('No agent mailbox registered');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${buildCompactInstructions(['inbox', 'morgan-ellery'], null, NO_CAPABILITIES)}\n`);
  });

  it("prints a task session's instructions, naming the task's summary file", async () => {
    const result = await runHook({ destinations: ['morgan-ellery'], threadId: 'system:tasks:weekly-review' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${buildCompactInstructions(['morgan-ellery'], 'weekly-review', NO_CAPABILITIES)}\n`);
  });
});
