/**
 * Destructive teardown primitive — used by the `--reinstall` flow in gws-ea.ts
 * and by setup/uninstall.ts.
 *
 * Builds a list of PlanStep, prints them, asks for confirmation, then
 * executes. Idempotent: an already-torn-down install yields an empty plan.
 *
 * Scopes:
 *   - state: stop service, delete v2-tagged OneCLI agents, wipe data/, logs/,
 *            dist/, untracked files in groups/* and container/*.
 *   - host:  state + remove the launchd plist / systemd unit + delete .env.
 *   - gcp:   host + run setup/provision-gcp.sh --delete (its own confirm).
 */
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import * as p from '@clack/prompts';
import k from 'kleur';

import { DATA_DIR } from '../src/config.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';

export type TeardownScope = 'state' | 'host' | 'gcp';

export interface TeardownOptions {
  yes?: boolean;
}

interface PlanStep {
  describe(): string;
  execute(): Promise<void>;
}

interface OneCliAgent {
  id: string;
  name: string;
  identifier: string;
}

const PROJECT_ROOT = process.cwd();
const V2_DB_PATH = path.join(DATA_DIR, 'v2.db');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const GCP_SCRIPT = path.join(PROJECT_ROOT, 'setup', 'provision-gcp.sh');
const CLEAN_PATHS = ['groups/', 'container/'] as const;

// ── service (cross-platform) ────────────────────────────────────────────

function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${getLaunchdLabel()}.plist`);
}

function systemdUnitFile(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${getSystemdUnit()}.service`);
}

function isServiceLoaded(): boolean {
  if (os.platform() === 'darwin') {
    return spawnSync('launchctl', ['list', getLaunchdLabel()], { stdio: 'ignore' }).status === 0;
  }
  if (os.platform() === 'linux') {
    return spawnSync('systemctl', ['--user', 'is-active', '--quiet', `${getSystemdUnit()}.service`], { stdio: 'ignore' }).status === 0;
  }
  return false;
}

function stopService(): void {
  if (os.platform() === 'darwin') {
    const plist = plistPath();
    const args = fs.existsSync(plist) ? ['unload', plist] : ['unload', getLaunchdLabel()];
    spawnSync('launchctl', args, { stdio: 'inherit' });
    return;
  }
  if (os.platform() === 'linux') {
    spawnSync('systemctl', ['--user', 'stop', `${getSystemdUnit()}.service`], { stdio: 'inherit' });
  }
}

function serviceUnitFile(): string | null {
  if (os.platform() === 'darwin') {
    const f = plistPath();
    return fs.existsSync(f) ? f : null;
  }
  if (os.platform() === 'linux') {
    const f = systemdUnitFile();
    return fs.existsSync(f) ? f : null;
  }
  return null;
}

// ── OneCLI ──────────────────────────────────────────────────────────────

/**
 * Find OneCLI agents tagged with this install's agent_group ids. Read the
 * DB read-only and skip migrations — we're about to delete it; mutating
 * its schema_version mid-teardown would be surprising.
 */
function listV2OneCliAgents(): OneCliAgent[] {
  if (!fs.existsSync(V2_DB_PATH) || fs.statSync(V2_DB_PATH).size === 0) return [];

  let agentGroupIds: Set<string>;
  try {
    const db = new Database(V2_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT id FROM agent_groups').all() as Array<{ id: string }>;
      agentGroupIds = new Set(rows.map((r) => r.id));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
  if (agentGroupIds.size === 0) return [];

  const r = spawnSync('onecli', ['agents', 'list'], { encoding: 'utf-8' });
  if (r.status !== 0) return [];

  try {
    const all = JSON.parse(r.stdout) as Array<{ id: string; name: string; identifier: string }>;
    return all.filter((a) => a.identifier && agentGroupIds.has(a.identifier));
  } catch {
    return [];
  }
}

async function deleteOneCliAgent(id: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('onecli', ['agents', 'delete', '--id', id], { stdio: 'inherit' });
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
}

// ── filesystem cleanup ──────────────────────────────────────────────────

function existingPaths(candidates: string[]): string[] {
  return candidates.filter(fs.existsSync);
}

/** Use git's own preview to get a stable list of what `git clean -fdx` will touch. */
function listUntrackedToClean(): string[] {
  const r = spawnSync('git', ['clean', '-ndx', ...CLEAN_PATHS], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    p.log.warn(`git clean preview failed (status ${r.status}); skipping untracked-file cleanup`);
    return [];
  }
  return r.stdout
    .split('\n')
    .filter((line) => line.startsWith('Would remove '))
    .map((line) => line.slice('Would remove '.length).trim())
    .filter(Boolean);
}

function gitCleanGroupsAndContainer(): void {
  spawnSync('git', ['clean', '-fdx', ...CLEAN_PATHS], { cwd: PROJECT_ROOT, stdio: 'inherit' });
}

// ── plan construction ──────────────────────────────────────────────────

function buildPlan(scope: TeardownScope): PlanStep[] {
  const steps: PlanStep[] = [];

  // state ────────────────────────────────────────────────────────────────
  if (isServiceLoaded()) {
    steps.push({
      describe: () => `Stop service: ${getLaunchdLabel()}`,
      execute: async () => stopService(),
    });
  }

  const oneCliAgents = listV2OneCliAgents();
  if (oneCliAgents.length > 0) {
    steps.push({
      describe: () =>
        oneCliAgents.map((a) => `Delete OneCLI agent: ${a.name} (${a.identifier})`).join('\n'),
      execute: async () => {
        await Promise.all(oneCliAgents.map((a) => deleteOneCliAgent(a.id)));
      },
    });
  }

  for (const dir of existingPaths(['data', 'logs', 'dist'].map((d) => path.join(PROJECT_ROOT, d)))) {
    steps.push({
      describe: () => `Delete: ${path.relative(PROJECT_ROOT, dir)}/`,
      execute: async () => fs.rmSync(dir, { recursive: true, force: true }),
    });
  }

  const untracked = listUntrackedToClean();
  if (untracked.length > 0) {
    steps.push({
      describe: () => untracked.map((u) => `Delete (untracked): ${u}`).join('\n'),
      execute: async () => gitCleanGroupsAndContainer(),
    });
  }

  if (scope === 'state') return steps;

  // host ─────────────────────────────────────────────────────────────────
  const unitFile = serviceUnitFile();
  if (unitFile) {
    steps.push({
      describe: () => `Remove service unit: ${unitFile}`,
      execute: async () => fs.rmSync(unitFile, { force: true }),
    });
  }

  if (fs.existsSync(ENV_PATH)) {
    steps.push({
      describe: () => `Delete: ${path.relative(PROJECT_ROOT, ENV_PATH)}`,
      execute: async () => fs.rmSync(ENV_PATH, { force: true }),
    });
  }

  if (scope === 'host') return steps;

  // gcp ──────────────────────────────────────────────────────────────────
  if (fs.existsSync(GCP_SCRIPT)) {
    steps.push({
      describe: () => `Run: ${path.relative(PROJECT_ROOT, GCP_SCRIPT)} --delete (separate confirm)`,
      execute: async () => {
        spawnSync('bash', [GCP_SCRIPT, '--delete'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
      },
    });
  }

  return steps;
}

// ── public API ──────────────────────────────────────────────────────────

export async function teardown(scope: TeardownScope, opts: TeardownOptions = {}): Promise<void> {
  const steps = buildPlan(scope);
  if (steps.length === 0) {
    p.log.info('Nothing to tear down.');
    return;
  }

  p.note(steps.map((s) => s.describe()).join('\n'), `Teardown plan (scope: ${scope})`);

  if (!opts.yes) {
    const ok = await p.confirm({
      message: `Proceed with teardown (scope: ${scope})?`,
      initialValue: false,
    });
    if (p.isCancel(ok) || !ok) {
      p.cancel('Teardown cancelled.');
      process.exit(0);
    }
  }

  for (const step of steps) {
    p.log.info(step.describe().split('\n')[0]);
    await step.execute();
  }
  p.log.success(k.green('Teardown complete.'));
}
