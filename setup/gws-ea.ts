/**
 * Nanoclaw GWS-EA setup orchestrator.
 *
 * Detects fresh install / v1 migration / reconfigure, runs upstream's
 * setup/auto.ts (with NANOCLAW_SKIP=cli-agent,channel,first-chat) for host setup,
 * then runs EA-specific init scripts (gchat DM, email, heartbeat, optional
 * matters migration). On migrate runs, hard-cuts over from v1 launchd at the
 * end. Idempotent.
 *
 * Env: NANOCLAW_V1_PATH overrides v1 location. See `--help` for flags.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import * as p from '@clack/prompts';
import k from 'kleur';

import { DATA_DIR } from '../src/config.js';
import { deleteAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  deleteMessagingGroup,
  deleteMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByAgentGroup,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { readEnvFile } from '../src/env.js';
import { slugifyAssistant } from '../src/install-slug.js';
import { getMembers, removeMember } from '../src/modules/permissions/db/agent-group-members.js';

interface Args {
  /** `true` = auto-yes to v1-import prompt; `false` = auto-no; `null` = ask interactively. */
  migrate: boolean | null;
  v1Path: string | null;
  /** Run destructive teardown(state) before normal setup flow. */
  reinstall: boolean;
  /** With --reinstall, skip the teardown confirmation. */
  yes: boolean;
  help: boolean;
}

interface DetectedV1 {
  path: string;
  env: Record<string, string>;
}

const PROJECT_ROOT = process.cwd();

const V1_PLIST_LABEL = 'com.nanoclaw';

const REQUIRED_ENV_KEYS = [
  'PRINCIPAL_NAME',
  'PRINCIPAL_EMAILS',
  'ASSISTANT_NAME',
  'ASSISTANT_EMAIL',
  'GCHAT_PUBSUB_TOPIC',
  'HEARTBEAT_SPACE_ID',
] as const;

const OPTIONAL_ENV_KEYS = ['PRINCIPAL_LAST_NAME', 'ASSISTANT_LAST_NAME'] as const;

type EnvKey = (typeof REQUIRED_ENV_KEYS)[number] | (typeof OPTIONAL_ENV_KEYS)[number];

const ENV_PROMPTS: Record<EnvKey, string> = {
  PRINCIPAL_NAME: "Principal's first name",
  PRINCIPAL_LAST_NAME: "Principal's last name (optional, blank for mononymous)",
  PRINCIPAL_EMAILS: "Principal's email addresses (comma-separated; first = primary)",
  ASSISTANT_NAME: "Assistant's first name",
  ASSISTANT_LAST_NAME: "Assistant's last name (optional, blank for mononymous)",
  ASSISTANT_EMAIL: "Assistant's Workspace email",
  GCHAT_PUBSUB_TOPIC: 'GChat Pub/Sub topic (projects/<proj>/topics/<topic>)',
  HEARTBEAT_SPACE_ID: 'Heartbeat GChat space ID',
};

// ── output helpers ─────────────────────────────────────────────────────

function step(label: string): void {
  console.log('\n' + k.cyan('▸') + ' ' + k.bold(label));
}
function ok(msg: string): void {
  console.log('  ' + k.green('✓') + ' ' + msg);
}
function info(msg: string): void {
  console.log('  ' + k.dim('•') + ' ' + k.dim(msg));
}
function skip(msg: string): void {
  console.log('  ' + k.dim('·') + ' ' + k.dim(`[skip] ${msg}`));
}
function fail(msg: string, hint?: string): never {
  console.log('  ' + k.red('✗') + ' ' + msg);
  if (hint) {
    for (const line of hint.split('\n')) console.log('    ' + k.dim(line));
  }
  process.exit(1);
}

// ── flag parsing ───────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Args = { migrate: null, v1Path: null, reinstall: false, yes: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--migrate') out.migrate = true;
    else if (a === '--no-migrate') out.migrate = false;
    else if (a === '--reinstall') out.reinstall = true;
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--v1-path') {
      const next = argv[i + 1];
      if (!next) throw new Error('--v1-path requires an argument');
      out.v1Path = next;
      i++;
    } else if (a.startsWith('--v1-path=')) {
      out.v1Path = a.slice('--v1-path='.length);
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`
${k.bold('setup-gws-ea.sh')} — Nanoclaw GWS-EA setup orchestrator

Idempotent. Bootstraps the host, runs the canonical v2 init scripts
(main agent + GChat DM, email-principal/external, heartbeat), then —
if a v1 install is detected — asks whether to import its custom
agents/tasks on top.

  ${k.bold('Options')}:
    --migrate       answer "yes" to the v1-import prompt (non-interactive)
    --no-migrate    answer "no" — keep v1 alone, just (re-)run init
    --v1-path PATH  explicit v1 install path (default: sibling-scan)
    --reinstall     destructive: wipe v2 state, then run setup
                    (preserves .env, plist, GCP)
    --yes, -y       skip the --reinstall teardown confirmation
    --help          show this message

  ${k.bold('Tear-down')}:
    bash setup-uninstall.sh         remove this install (keeps GCP)
    bash setup-uninstall.sh --gcp   also tear down GCP resources
`);
}

// ── env IO ─────────────────────────────────────────────────────────────

function readEnv(envFile: string): Record<string, string> {
  if (!fs.existsSync(envFile)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(envFile, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function writeEnv(envFile: string, values: Record<string, string>): void {
  const existing = readEnv(envFile);
  const merged = { ...existing, ...values };
  const keys = Object.keys(merged).sort();
  const lines = keys.map((k) => `${k}=${merged[k]}`);
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, `${envFile}.bak`);
  }
  fs.writeFileSync(envFile, lines.join('\n') + '\n');
}

// ── mode detection ─────────────────────────────────────────────────────

/** v1 marker: store/messages.db (the v1 SQLite DB) AND .env with ASSISTANT_NAME. */
function looksLikeV1Install(dir: string): boolean {
  if (!fs.existsSync(path.join(dir, 'store', 'messages.db'))) return false;
  const envFile = path.join(dir, '.env');
  if (!fs.existsSync(envFile)) return false;
  return Boolean(readEnv(envFile).ASSISTANT_NAME);
}

/**
 * Find a v1 nanoclaw-gws-ea install. Expected layout (per migration plan
 * Phase 2) is a sibling worktree of PROJECT_ROOT. Resolves via --v1-path /
 * NANOCLAW_V1_PATH override, then stem-match (strip `-v2` suffix), then any
 * sibling matching the v1 marker.
 */
function findV1Install(explicit: string | null): DetectedV1 | null {
  if (explicit) {
    if (!looksLikeV1Install(explicit)) return null;
    return { path: explicit, env: readEnv(path.join(explicit, '.env')) };
  }
  if (process.env.NANOCLAW_V1_PATH) {
    const dir = process.env.NANOCLAW_V1_PATH;
    if (looksLikeV1Install(dir)) return { path: dir, env: readEnv(path.join(dir, '.env')) };
  }

  const parent = path.dirname(PROJECT_ROOT);
  const selfName = path.basename(PROJECT_ROOT);
  const stem = selfName.replace(/-v2(?:[-.].*)?$/, '');
  if (stem && stem !== selfName) {
    const sibling = path.join(parent, stem);
    if (looksLikeV1Install(sibling)) return { path: sibling, env: readEnv(path.join(sibling, '.env')) };
  }
  try {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === selfName) continue;
      const dir = path.join(parent, entry.name);
      if (looksLikeV1Install(dir)) return { path: dir, env: readEnv(path.join(dir, '.env')) };
    }
  } catch {
    // parent unreadable — skip
  }
  return null;
}

/**
 * Detect v1 install + show what kind of run this will be. Pure detection;
 * does NOT gate behavior — init scripts run unconditionally, and the
 * v1-import decision is asked separately, after init succeeds (see
 * shouldImportV1).
 */
function detectAndAnnounce(args: Args): DetectedV1 | null {
  // Refuse if v1 data files (store/messages.db) sit in this v2 checkout —
  // user did `git pull` over v1 instead of creating a worktree.
  if (looksLikeV1Install(PROJECT_ROOT) && fs.existsSync(path.join(PROJECT_ROOT, 'setup', 'gws-ea.ts'))) {
    fail(
      'You appear to be in a v1 install with v2 code on top (store/messages.db is present here).',
      'Roll back this checkout to its v1 commit, then create a sibling worktree for v2:\n' +
      '    git reset --hard <v1-commit-sha>      # leave v1 running here\n' +
      `    git worktree add ${path.dirname(PROJECT_ROOT)}/${path.basename(PROJECT_ROOT)}-v2 origin/main\n` +
      `    cd ${path.dirname(PROJECT_ROOT)}/${path.basename(PROJECT_ROOT)}-v2\n` +
      '    bash setup-gws-ea.sh',
    );
  }

  const v1 = findV1Install(args.v1Path);
  const v2Ready = v2FullyConfigured();

  p.intro(k.bgCyan(k.black(' setup-gws-ea ')));
  if (v2Ready) {
    p.log.info(`v2 fully configured at ${PROJECT_ROOT} — re-running init steps idempotently.`);
  } else {
    p.log.info(`Setting up v2 at ${PROJECT_ROOT}.`);
  }
  if (v1) p.log.info(`v1 install detected at ${v1.path} — will offer to import after init.`);

  if (args.migrate === true && !v1) {
    fail('--migrate requested but no v1 install found. Use --v1-path or set NANOCLAW_V1_PATH.');
  }

  return v1;
}

/**
 * Strong "v2 install is wired end-to-end" check — used only for status
 * messaging. The init scripts are individually idempotent, so we don't
 * need to gate on this; we just want to tell the user what they're
 * looking at.
 */
function v2FullyConfigured(): boolean {
  const dbPath = path.join(PROJECT_ROOT, 'data', 'v2.db');
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return false;

  const db = initDb(dbPath);
  runMigrations(db);

  const main = getAgentGroupByFolder('main');
  const external = getAgentGroupByFolder('email-external');
  if (!main || !external) return false;

  const mainWirings = getMessagingGroupsByAgentGroup(main.id);
  const hasOwnerDm = mainWirings.some((m) => m.channel_type === 'gchat' && m.is_group === 0);
  const hasPrincipalEmail = mainWirings.some((m) => m.platform_id.startsWith('email:principal:'));
  const hasHeartbeat = mainWirings.some((m) => m.channel_type === 'gchat' && m.is_group === 1);

  const externalWirings = getMessagingGroupsByAgentGroup(external.id);
  const hasExternalEmail = externalWirings.some((m) => m.platform_id.startsWith('email:external:'));

  return hasOwnerDm && hasPrincipalEmail && hasHeartbeat && hasExternalEmail;
}

/**
 * Decide whether to run the v1 → v2 data import. Asked AFTER init
 * succeeds so a working v2 always lands first; v1 import is a separate
 * opt-in layered on top.
 */
async function shouldImportV1(args: Args, v1: DetectedV1 | null): Promise<boolean> {
  if (!v1) return false;
  if (args.migrate === true) return true;
  if (args.migrate === false) return false;

  const want = await p.confirm({
    message: `Import v1 data from ${v1.path}? (custom agents + active scheduled tasks)`,
    initialValue: true,
  });
  if (p.isCancel(want)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return want === true;
}

// ── config collection ──────────────────────────────────────────────────

async function promptValue(label: string, initial: string): Promise<string> {
  const v = await p.text({
    message: label,
    initialValue: initial,
    validate: (raw) => (raw.trim().length === 0 ? 'Required' : undefined),
  });
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return v.trim();
}

async function promptOptional(label: string, initial: string): Promise<string> {
  const v = await p.text({ message: label, initialValue: initial });
  if (p.isCancel(v)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }
  return v.trim();
}

async function collectConfig(v1: DetectedV1 | null): Promise<void> {
  step('Configure .env');
  const envFile = path.join(PROJECT_ROOT, '.env');
  const current = readEnv(envFile);
  // Prefer current's values; fall back to v1's .env when current is missing
  // a key. Lets first-time installs alongside a v1 worktree pick up the same
  // identity / GCP config as v1 without re-prompting.
  const seed: Record<string, string> = v1 ? { ...v1.env, ...current } : current;

  const collected: Record<string, string> = {};
  for (const key of REQUIRED_ENV_KEYS) {
    const initial = seed[key] ?? '';
    collected[key] = await promptValue(ENV_PROMPTS[key], initial);
  }
  for (const key of OPTIONAL_ENV_KEYS) {
    const initial = seed[key] ?? '';
    const value = await promptOptional(ENV_PROMPTS[key], initial);
    if (value) collected[key] = value;
  }
  if (!current.ONECLI_URL) collected.ONECLI_URL = 'http://127.0.0.1:10254';

  writeEnv(envFile, collected);
  ok(`.env written (${Object.keys(collected).length} keys)`);
}

// ── shell helpers ──────────────────────────────────────────────────────

function runShell(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): SpawnSyncReturns<Buffer> {
  return spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: 'inherit',
  });
}

function runShellQuiet(cmd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── steps ──────────────────────────────────────────────────────────────

async function runGcpSetup(): Promise<void> {
  step('GCP provisioning (setup/provision-gcp.sh)');
  const script = path.join(PROJECT_ROOT, 'setup', 'provision-gcp.sh');
  if (!fs.existsSync(script)) fail(`provision-gcp.sh not found at ${script}`);

  // Skip the full provision run when --check passes (idempotent fast path).
  const checkResult = runShellQuiet('bash', [script, '--check']);
  if (checkResult.code === 0 && /all checks passed/i.test(checkResult.stdout)) {
    skip('GCP already provisioned (--check passed)');
    return;
  }

  info('Running provision-gcp.sh — pauses for the DWD admin-console step');
  const r = runShell('bash', [script]);
  if (r.status !== 0) fail('provision-gcp.sh failed. Re-run setup-gws-ea.sh after fixing the issue.');
  ok('GCP provisioned');
}

function verifySaKey(): void {
  step('Verify service-account key');
  const env = readEnvFile(['ASSISTANT_NAME']);
  const name = env.ASSISTANT_NAME;
  if (!name) fail('ASSISTANT_NAME missing from .env');
  const saPath = path.join(os.homedir(), '.gws', slugifyAssistant(name), 'service-account.json');
  if (!fs.existsSync(saPath)) {
    fail(`SA key not found at ${saPath}. Re-run setup/provision-gcp.sh.`);
  }
  ok(`SA key present at ${saPath}`);
}

function buildTemplateSubstitutions(env: Record<string, string>): Record<string, string> {
  const fullName = (first: string, last: string) => [first, last].filter(Boolean).join(' ');
  const calendarRows = (env.PRINCIPAL_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((email) => `| <fill in name> | ${email} |  |`)
    .join('\n');
  return {
    ASSISTANT_NAME: env.ASSISTANT_NAME ?? '',
    ASSISTANT_LAST_NAME: env.ASSISTANT_LAST_NAME ?? '',
    ASSISTANT_FULL_NAME: fullName(env.ASSISTANT_NAME ?? '', env.ASSISTANT_LAST_NAME ?? ''),
    ASSISTANT_EMAIL: env.ASSISTANT_EMAIL ?? '',
    PRINCIPAL_NAME: env.PRINCIPAL_NAME ?? '',
    PRINCIPAL_LAST_NAME: env.PRINCIPAL_LAST_NAME ?? '',
    PRINCIPAL_FULL_NAME: fullName(env.PRINCIPAL_NAME ?? '', env.PRINCIPAL_LAST_NAME ?? ''),
    PRINCIPAL_EMAILS: env.PRINCIPAL_EMAILS ?? '',
    PRINCIPAL_CALENDAR_ROWS: calendarRows,
  };
}

const RENDERED_FILES_NEEDING_EDITS: string[] = [];

interface MergeTask {
  from: string; // path relative to PROJECT_ROOT
  to: string; // path relative to PROJECT_ROOT
  note: string; // short context for the merge
}
const MERGE_TASKS: MergeTask[] = [];

const PROCEDURE_TO_V2: Record<string, string> = {
  'scheduling.md': 'container/skills/scheduling/SKILL.md',
  'email-triage.md': 'container/skills/email-triage/SKILL.md',
  'morning-briefing.md': 'groups/main/heartbeats/morning-briefing.md',
  'weekly-review.md': 'groups/main/heartbeats/weekly-review.md',
  'heartbeat-sweep.md': 'groups/main/heartbeats/sweep.md',
};

function renderTemplates(): void {
  step('Render persona templates');
  const env = readEnvFile([
    'ASSISTANT_NAME',
    'ASSISTANT_LAST_NAME',
    'ASSISTANT_EMAIL',
    'PRINCIPAL_NAME',
    'PRINCIPAL_LAST_NAME',
    'PRINCIPAL_EMAILS',
  ]);
  const subs = buildTemplateSubstitutions(env);
  const templatesRoot = path.join(PROJECT_ROOT, 'templates');
  if (!fs.existsSync(templatesRoot)) {
    skip('no templates/ directory');
    return;
  }
  let count = 0;
  RENDERED_FILES_NEEDING_EDITS.length = 0;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(templatesRoot, fullPath);
      const target = path.join(PROJECT_ROOT, rel);
      let content = fs.readFileSync(fullPath, 'utf-8');
      for (const [k, v] of Object.entries(subs)) {
        content = content.replaceAll(`{{${k}}}`, v);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      count++;
      // <!-- Customize ... --> or <fill in ...> markers tell the user the
      // file still needs hand-edits before going live.
      if (/<!--\s*(customize|replace|fill in)/i.test(content) || /<fill in/i.test(content)) {
        RENDERED_FILES_NEEDING_EDITS.push(rel);
      }
    }
  };
  walk(templatesRoot);
  ok(`Rendered ${count} template${count === 1 ? '' : 's'}`);
}

async function runUpstreamAuto(): Promise<void> {
  step('Upstream host setup (deps, container, onecli, auth, mounts, service, cli-agent, tz)');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'setup/auto.ts'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        // Skip 'verify' — it checks for registered_groups and configured channels,
        // but those are seeded later by runInit*. Running it here triggers a
        // misleading "failed" status and an interactive offerClaudeAssist prompt
        // that can drop the user out of the gws-ea flow before init runs. The
        // smokeTest at the end of gws-ea covers the same checks at the right time.
        NANOCLAW_SKIP: 'cli-agent,channel,first-chat,verify',
      },
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`setup/auto.ts exited with code ${code}`));
    });
    child.on('error', reject);
  }).catch((err) => fail(`Upstream auto.ts failed: ${(err as Error).message}`));
  ok('Upstream setup complete');
}

async function runMigrateV2(v1Path: string): Promise<void> {
  step('Migrate generic v1 data (groups, channels, tasks) via migrate-v2.sh');
  await new Promise<void>((resolve, reject) => {
    const child = spawn('bash', ['migrate-v2.sh'], {
      cwd: PROJECT_ROOT,
      stdio: 'inherit',
      env: { ...process.env, NANOCLAW_V1_PATH: v1Path },
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`migrate-v2.sh exited with code ${code}`));
    });
    child.on('error', reject);
  }).catch((err) => fail(`migrate-v2.sh failed: ${(err as Error).message}`));
  ok('v1 → v2 migration complete');
}

function tsxScript(rel: string, scriptArgs: string[] = []): void {
  const r = runShell('pnpm', ['exec', 'tsx', rel, ...scriptArgs]);
  if (r.status !== 0) fail(`${rel} failed (exit ${r.status})`);
}

interface GchatDmIds {
  platformId: string; // "gchat:AAAA1234567"
  userId: string; // "gchat:users/123456789"
}

/**
 * Lift the GChat DM space + principal user-id from v1's messages.db.
 * Space comes from `registered_groups` (folder='main'); user-id from any
 * non-self `messages.sender` row in that DM.
 */
function liftGchatDmFromV1(v1Path: string): GchatDmIds | null {
  const dbPath = path.join(v1Path, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const mainRow = db
      .prepare("SELECT jid FROM registered_groups WHERE folder = 'main' AND jid LIKE 'gchat:%' LIMIT 1")
      .get() as { jid: string } | undefined;
    if (!mainRow?.jid) return null;
    const senderRow = db
      .prepare(
        `SELECT sender FROM messages
          WHERE chat_jid = ? AND is_from_me = 0 AND sender LIKE 'users/%'
          ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(mainRow.jid) as { sender: string } | undefined;
    if (!senderRow?.sender) return null;
    return { platformId: mainRow.jid, userId: `gchat:${senderRow.sender}` };
  } finally {
    db.close();
  }
}

async function runInitFirstAgent(v1: DetectedV1 | null): Promise<void> {
  step('Init first agent (main, GChat DM)');
  // No early-skip: scripts/init-first-agent.ts is itself idempotent
  // (getAgentGroupByFolder('main') short-circuits create paths). Always
  // invoke so partial state from a prior failed run gets filled in.
  const env = readEnvFile(['ASSISTANT_NAME', 'PRINCIPAL_NAME']);
  const principal = env.PRINCIPAL_NAME;
  const assistantName = env.ASSISTANT_NAME;
  if (!principal) fail('PRINCIPAL_NAME missing from .env');
  if (!assistantName) fail('ASSISTANT_NAME missing from .env');

  let lifted: GchatDmIds | null = null;
  if (v1) {
    lifted = liftGchatDmFromV1(v1.path);
    if (lifted) info(`Auto-detected from v1: platform=${lifted.platformId}, user=${lifted.userId}`);
    else info('No GChat DM found in v1 DB — falling back to prompts');
  }

  const platformId =
    lifted?.platformId ??
    `gchat:${await promptValue(
      "Principal's GChat DM space ID (e.g. AAAA1234567 — found in the DM URL)",
      '',
    )}`;
  const userId = lifted?.userId ?? (await promptValue('Principal GChat user id (gchat:users/<numeric>)', ''));

  tsxScript('scripts/init-first-agent.ts', [
    '--channel',
    'gchat',
    '--user-id',
    userId,
    '--platform-id',
    platformId,
    '--display-name',
    principal,
    '--agent-name',
    assistantName,
    '--role',
    'owner',
    // Single-principal fork — keep the canonical 'main' folder so init-email
    // and init-heartbeat can find it predictably (they both look up by folder).
    '--folder',
    'main',
  ]);
  ok('main agent group + GChat DM wired');
}

function runInitEmail(): void {
  step('Init email channel (principal + external)');
  tsxScript('scripts/init-email.ts');
  ok('email mgs + wirings seeded');
}

function runInitHeartbeat(): void {
  step('Init heartbeat (sweep + morning-briefing + weekly-review)');
  tsxScript('scripts/init-heartbeat.ts');
  ok('heartbeat space wired + all heartbeat ticks seeded');
}

/**
 * migrate-v2.sh seeds messaging_groups for v1's `email:principal` /
 * `email:external` JIDs (no email-suffix), but our init-email.ts creates the
 * canonical v2 form (`email:principal:<addr>` / `email:external:<addr>`).
 * Drop the legacy ones so the runtime doesn't see two "principal email" mgs.
 * Also drops the v1 agent_groups (folder='email', 'external-contact') if no
 * other wirings reference them. Folders on disk are left in place — content
 * may need hand-merge into main/ + email-external/.
 *
 * Cascades to `agent_destinations` rows that targeted the legacy mgs —
 * those rows survive the agent-group rename (i6ozqn was 'external-contact',
 * 7bzn5g was 'email') and produce a duplicate channel destination on the
 * renamed agent that routes back into the recipient's email thread.
 */
function cleanupV1EmailOrphans(): void {
  step('Clean up v1 email synthetic orphans');
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const orphanPlatformIds = ['email:principal', 'email:external'];
  // Includes both the v1 raw folder names AND `email-principal` — some
  // migrations rename the v1 'email' folder to 'email-principal' before
  // cleanup runs, leaving an unwired agent group whose canonical traffic
  // (`email:principal:<addr>`) is wired to `main` by init-email.ts.
  const orphanFolders: Array<{ folder: string; routesTo: string }> = [
    { folder: 'email', routesTo: 'main' },
    { folder: 'email-principal', routesTo: 'main' },
    { folder: 'external-contact', routesTo: 'email-external' },
  ];

  let mgs = 0;
  let mgas = 0;
  let ags = 0;
  let dests = 0;

  for (const platformId of orphanPlatformIds) {
    const mg = getMessagingGroupByPlatform('email', platformId);
    if (!mg) continue;
    for (const mga of getMessagingGroupAgents(mg.id)) {
      deleteMessagingGroupAgent(mga.id);
      mgas++;
    }
    if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_destinations'").get()) {
      const res = db
        .prepare("DELETE FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?")
        .run(mg.id);
      dests += res.changes;
    }
    deleteMessagingGroup(mg.id);
    mgs++;
  }

  for (const { folder, routesTo } of orphanFolders) {
    const ag = getAgentGroupByFolder(folder);
    if (!ag) continue;
    if (getMessagingGroupsByAgentGroup(ag.id).length > 0) {
      info(`agent_group folder='${folder}' still has wirings — leaving in place`);
      continue;
    }
    for (const m of getMembers(ag.id)) removeMember(m.user_id, ag.id);
    try {
      deleteAgentGroup(ag.id);
      ags++;
    } catch (err) {
      info(`could not delete agent_group folder='${folder}': ${(err as Error).message}`);
      continue;
    }
    const folderPath = path.join(PROJECT_ROOT, 'groups', folder);
    if (fs.existsSync(folderPath)) {
      MERGE_TASKS.push({
        from: `groups/${folder}/`,
        to: `groups/${routesTo}/`,
        note: `v1 ${folder === 'email' ? 'principal' : 'external'}-email persona/memory; v2 routes that traffic to "${routesTo}"`,
      });
    }
  }

  if (mgs + mgas + ags + dests === 0) skip('no v1 email orphans found');
  else ok(`removed ${mgs} mg, ${mgas} mga, ${dests} agent_destinations, ${ags} ag (folders preserved on disk for review)`);
}

/**
 * v1 stored hand-edited persona docs at groups/global/procedures/. v2 reads
 * from rendered container/skills/<name>/SKILL.md and groups/main/heartbeats/*.md.
 * migrate-v2.sh copies the v1 folder verbatim; flag the leftovers so the user
 * knows to hand-merge.
 */
function scanV1ProcedureLeftovers(): void {
  step('Scan for v1 persona customizations');
  const dir = path.join(PROJECT_ROOT, 'groups', 'global', 'procedures');
  if (!fs.existsSync(dir)) {
    skip('no v1 groups/global/procedures/ found');
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    skip('no .md files in groups/global/procedures/');
    return;
  }
  ok(`found ${files.length} v1 procedure file${files.length === 1 ? '' : 's'}`);
  for (const f of files) {
    const dest = PROCEDURE_TO_V2[f];
    MERGE_TASKS.push({
      from: `groups/global/procedures/${f}`,
      to: dest ?? '(no canonical v2 file — pick one or drop)',
      note: dest
        ? `v1 hand-edited persona doc; v2 ${dest.startsWith('container/') ? 'renders this from templates/ at setup, so any custom guidance must go into the rendered file' : 'reads the heartbeat tick directly'}`
        : 'no obvious v2 home — review and either fold into an existing doc or drop',
    });
  }
}

async function maybeMigrateMatters(v1: DetectedV1): Promise<void> {
  step('Optional: migrate matters from v1');
  const want = await p.confirm({
    message: 'Migrate matters table from v1? (preserves matter context across migration)',
    initialValue: true,
  });
  if (p.isCancel(want) || !want) {
    skip('matters migration declined');
    return;
  }
  tsxScript('setup/migrate-v2/matters.ts', ['--v1-db', path.join(v1.path, 'store', 'messages.db')]);
  ok('matters migrated');
}

function hardMigrateFromV1(): void {
  step('Hard migrate from v1 launchd');
  // launchctl list <label> returns 0 if loaded.
  const list = runShellQuiet('launchctl', ['list', V1_PLIST_LABEL]);
  if (list.code !== 0) {
    skip(`v1 plist (${V1_PLIST_LABEL}) not loaded`);
    return;
  }
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${V1_PLIST_LABEL}.plist`);
  if (fs.existsSync(plistPath)) {
    const r = runShellQuiet('launchctl', ['unload', plistPath]);
    if (r.code !== 0) {
      info(`launchctl unload ${plistPath} returned ${r.code}; continuing`);
      return;
    }
    ok(`unloaded v1 plist (${V1_PLIST_LABEL})`);
    try {
      fs.unlinkSync(plistPath);
      ok(`removed v1 plist file (${plistPath})`);
    } catch (err) {
      info(`could not delete v1 plist file: ${(err as Error).message}`);
    }
  } else {
    info(`v1 plist file not found at ${plistPath} — already removed?`);
  }
}

function smokeTest(): void {
  step('Smoke test');
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  const counts = {
    ag: (db.prepare('SELECT count(*) AS n FROM agent_groups').get() as { n: number }).n,
    mg: (db.prepare('SELECT count(*) AS n FROM messaging_groups').get() as { n: number }).n,
    mga: (db.prepare('SELECT count(*) AS n FROM messaging_group_agents').get() as { n: number }).n,
  };
  if (counts.ag < 2 || counts.mg < 4 || counts.mga < 4) {
    info(`unexpected counts: ${JSON.stringify(counts)}`);
    info('expected at least: 2 agent_groups (main, email-external), 4 messaging_groups, 4 messaging_group_agents');
    info('not failing — re-run setup-gws-ea.sh if anything looks off');
  } else {
    ok(`db counts look good: ${JSON.stringify(counts)}`);
  }
}

function printSummary(imported: boolean): void {
  const env = readEnvFile(['ASSISTANT_NAME']);
  const assistantName = env.ASSISTANT_NAME ?? 'your assistant';
  step('Summary');
  console.log(`  v2 status:      ${v2FullyConfigured() ? 'fully configured' : 'partial — re-run setup-gws-ea.sh to retry'}`);
  console.log(`  v1 import:      ${imported ? 'yes' : 'no'}`);
  console.log(`  project root:   ${PROJECT_ROOT}`);
  console.log(`  .env:           ${path.join(PROJECT_ROOT, '.env')}`);
  console.log(`  central db:     ${path.join(PROJECT_ROOT, 'data', 'v2.db')}`);
  console.log(`  groups:         ${path.join(PROJECT_ROOT, 'groups')}`);
  console.log(`  logs:           ${path.join(PROJECT_ROOT, 'logs', 'nanoclaw.log')}`);
  console.log('');
  if (RENDERED_FILES_NEEDING_EDITS.length > 0) {
    console.log(k.yellow('These rendered files have placeholder sections — open and fill in:'));
    for (const f of RENDERED_FILES_NEEDING_EDITS) console.log('  ' + k.yellow('•') + ' ' + f);
    console.log('');
  }
  if (MERGE_TASKS.length > 0) {
    console.log(k.yellow('Hand-merge needed: v1 customizations to fold into v2.'));
    console.log(k.dim('Open Claude Code in this directory and paste the prompt below:'));
    console.log('');
    const divider = '─'.repeat(72);
    console.log(k.dim(divider));
    console.log('I just migrated from nanoclaw-gws-ea v1 to v2. Help me hand-merge each');
    console.log('v1 customization below into its v2 destination, one at a time. For each:');
    console.log('read both files, show me a diff and your merge plan, wait for my OK,');
    console.log('then write the merged result and rm the v1 source. Skip if v1 has');
    console.log('nothing v2 doesn\'t already cover.');
    console.log('');
    for (const t of MERGE_TASKS) {
      console.log(`- ${t.from} → ${t.to}`);
      console.log(`    (${t.note})`);
    }
    console.log(k.dim(divider));
    console.log('');
  }
  console.log(k.green(`Done. Send ${assistantName} a GChat DM to verify end-to-end.`));
  console.log(k.dim('Re-run setup-gws-ea.sh anytime; it is idempotent.'));
}

// ── main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(k.red((err as Error).message));
    printHelp();
    process.exit(1);
  }
  if (args.help) {
    printHelp();
    return;
  }

  if (args.reinstall) {
    const { teardown } = await import('./teardown.js');
    await teardown('state', { yes: args.yes });
  }

  const v1 = detectAndAnnounce(args);

  // ── 1. Bootstrap host (idempotent: deps, container image, OneCLI, service, tz)
  await collectConfig(v1);
  renderTemplates();
  await runGcpSetup();
  verifySaKey();
  await runUpstreamAuto();

  // ── 2. Init the canonical v2 set (idempotent: main + GChat DM, email
  //      principal/external, heartbeat space + ticks). Always runs so a
  //      partially-built install fills in whatever's missing.
  await runInitFirstAgent(v1);
  runInitEmail();
  runInitHeartbeat();

  // ── 3. Optional v1 → v2 import. Asked AFTER init so a working v2 lands
  //      first. Independent of bootstrap/init — declining doesn't break
  //      anything; accepting layers v1's custom agents and active tasks
  //      on top, plus matter/launchd cutover.
  const importing = await shouldImportV1(args, v1);
  if (importing && v1) {
    await runMigrateV2(v1.path);
    cleanupV1EmailOrphans();
    scanV1ProcedureLeftovers();
    await maybeMigrateMatters(v1);
    hardMigrateFromV1();
  }

  smokeTest();
  printSummary(importing);
}

main().catch((err) => {
  console.error(k.red(err instanceof Error ? err.stack ?? err.message : String(err)));
  process.exit(1);
});
