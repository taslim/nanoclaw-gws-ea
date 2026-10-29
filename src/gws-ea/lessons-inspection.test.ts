import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { runCli } from './cli.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
import { expectResultContract } from './testing/result-contract.js';
import { centralDatabaseFile } from './verify.js';
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it('reads queued lessons with the host stopped, without side files or runtime probes', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'u7-lessons-observation-'));
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const id = randomUUID();
  const reserved = await reserveInstance(paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 3201, onecli_gateway: 3202 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: 'juno@example.test',
      onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
    },
  });
  const runtime = await persistTestRuntime(paths, reserved);
  const file = centralDatabaseFile(runtime.state_root);
  await mkdir(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(
    'CREATE TABLE gws_ea_lessons (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL)',
  );
  db.prepare('INSERT INTO gws_ea_lessons VALUES (?,?,?,?)').run(
    'lesson-one',
    'Leave enough time between commitments.',
    'queued',
    '2026-10-28T21:00:00.000Z',
  );
  db.close();
  const before = await readdir(path.dirname(file));
  const stdout: string[] = [];
  const checkPrerequisites = vi.fn();
  const stoppedService = vi.fn(() => {
    throw new Error('The service is stopped');
  });
  expect(
    await runCli(['lessons', '--id', id, '--json'], {
      paths,
      environment: {},
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      checkPrerequisites,
      hostStatus: { queryHost: stoppedService, waitForHost: stoppedService },
    }),
  ).toBe(0);
  const result: unknown = JSON.parse(stdout.join('\n'));
  expectResultContract('lessons', result);
  expect(result).toMatchObject({
    outcome: 'succeeded',
    changed: false,
    data: {
      instance_id: id,
      lessons: [{ id: 'lesson-one', status: 'queued', text: 'Leave enough time between commitments.' }],
    },
  });
  expect(checkPrerequisites).not.toHaveBeenCalled();
  expect(stoppedService).not.toHaveBeenCalled();
  expect(await readdir(path.dirname(file))).toEqual(before);
});
